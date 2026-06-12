/*
 * talon — native launcher driver.
 *
 * A compiled front-door for the Talon CLI. Packaging layers (apt
 * `.deb`, Homebrew bottle, source install) ship this per-arch binary
 * as `talon`; it locates a suitable Node, then hands off to the
 * existing JS entry (`bin/talon.js`) so there is exactly one startup
 * code path. The npm install keeps invoking `bin/talon.js` directly —
 * this driver is for the native-binary distribution channels.
 *
 * Responsibilities, in order:
 *   1. Resolve the JS entry next to ourselves (TALON_JS overrides).
 *   2. Resolve a Node >= MIN_NODE_MAJOR. If TALON_NODE is set it is
 *      authoritative — used exactly, never overridden by a search.
 *      Otherwise the candidates, in priority order, are:
 *        <self>/vendor/node -> <self>/node -> PATH
 *          -> common install dirs -> version-manager hints
 *      The first candidate that exists AND reports major >= the floor
 *      wins; existing-but-too-old Nodes are remembered for diagnostics.
 *   3. Replace ourselves with `node <talon.js> <args...>` via execv, so
 *      signals, exit codes, and `ps` all pass straight through.
 *   4. On any miss — no Node, only an old Node, missing JS entry —
 *      print an actionable diagnostic to stderr and exit non-zero.
 *
 * POSIX-only by design: the native-binary channels are apt (Linux) and
 * Homebrew (macOS). Windows keeps using the portable `bin/talon.js`
 * npm shim, so there is no execv/fork dependency to emulate there.
 *
 * Written in C and compiled with the pinned Zig toolchain
 * (`zig cc`, native/.zig-version) so it cross-compiles per arch with
 * the same driver as the rest of the native plane. Zig was the first
 * choice, but Zig 0.16's process API is mid-refactor into the new `Io`
 * interface (no stable `execv`); a launcher this load-bearing wants the
 * boring, decades-stable POSIX calls instead.
 */

#if defined(_WIN32)
#error "talon-driver is POSIX-only; Windows uses the bin/talon.js npm shim."
#endif

/* Expose POSIX.2008 (readlink, strdup, strtok_r) before any include. */
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#else
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* Minimum Node major version — matches package.json `engines.node`. */
#define MIN_NODE_MAJOR 24

/* Exit codes, borrowing sysexits.h conventions. (stderr distinguishes
 * the cases; the code is intentionally coarse.) */
#define EX_UNAVAILABLE 69 /* no usable node, or JS entry missing */
#define EX_SOFTWARE 70    /* launcher internal error */
#define EX_NOEXEC 126     /* node located but execv() itself failed */

/* The most we ever track for the "found old node" diagnostic. */
#define MAX_REJECTED 16

struct rejected {
  char path[PATH_MAX];
  int major; /* -1 = version unknown */
};

static struct rejected g_rejected[MAX_REJECTED];
static size_t g_rejected_len = 0;

static void remember_rejected(const char *path, int major) {
  if (g_rejected_len >= MAX_REJECTED) return;
  snprintf(g_rejected[g_rejected_len].path, PATH_MAX, "%s", path);
  g_rejected[g_rejected_len].major = major;
  g_rejected_len++;
}

/* Join dir + "/" + leaf into out; returns false on truncation. */
static bool join_path(char *out, size_t cap, const char *dir,
                      const char *leaf) {
  int n = snprintf(out, cap, "%s/%s", dir, leaf);
  return n > 0 && (size_t)n < cap;
}

static bool file_exists(const char *path) { return access(path, F_OK) == 0; }

static bool is_executable(const char *path) { return access(path, X_OK) == 0; }

/* Directory containing this executable, resolved through symlinks. */
static bool self_exe_dir(char *out, size_t cap) {
  char buf[PATH_MAX];
#if defined(__APPLE__)
  char raw[PATH_MAX];
  uint32_t size = sizeof(raw);
  if (_NSGetExecutablePath(raw, &size) != 0) return false;
  if (realpath(raw, buf) == NULL) return false;
#else
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n < 0) return false;
  buf[n] = '\0';
#endif
  char *slash = strrchr(buf, '/');
  if (slash == NULL) return false;
  *slash = '\0';
  int w = snprintf(out, cap, "%s", buf);
  return w > 0 && (size_t)w < cap;
}

/*
 * Run `<node> --version` and parse the major from `vMAJOR.MINOR.PATCH`.
 * Returns the major, or -1 when the probe fails or output isn't a
 * version. fork + execl (no shell) so a node path with spaces or shell
 * metacharacters can never be reinterpreted.
 */
static int node_major(const char *node) {
  int fds[2];
  if (pipe(fds) != 0) return -1;

  pid_t pid = fork();
  if (pid < 0) {
    close(fds[0]);
    close(fds[1]);
    return -1;
  }
  if (pid == 0) {
    /* child: stdout -> pipe, stderr -> /dev/null, then exec node */
    dup2(fds[1], STDOUT_FILENO);
    int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) {
      dup2(devnull, STDERR_FILENO);
      close(devnull);
    }
    close(fds[0]);
    close(fds[1]);
    execl(node, node, "--version", (char *)NULL);
    _exit(127);
  }

  /*
   * Parent: capture the first line into buf, then keep draining to EOF.
   * Draining matters: a version-manager shim (asdf/mise/nvm/corepack)
   * may print a banner to stdout after the version. If we closed the
   * read end while the child was still writing, the child would take
   * SIGPIPE and die on a signal — and a perfectly usable Node would be
   * rejected as "version unreadable". Reading to EOF lets it exit 0.
   */
  close(fds[1]);
  char buf[64];
  char sink[256];
  size_t off = 0;
  ssize_t n;
  for (;;) {
    if (off < sizeof(buf) - 1) {
      n = read(fds[0], buf + off, sizeof(buf) - 1 - off);
      if (n > 0) {
        off += (size_t)n;
        continue;
      }
    } else {
      n = read(fds[0], sink, sizeof(sink)); /* discard past the first line */
      if (n > 0) continue;
    }
    break; /* EOF (0) or error (<0) */
  }
  buf[off] = '\0';
  close(fds[0]);

  int status;
  if (waitpid(pid, &status, 0) < 0) return -1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;

  const char *p = buf;
  if (*p == 'v') p++;
  if (*p < '0' || *p > '9') return -1;
  int major = 0;
  while (*p >= '0' && *p <= '9') {
    // Guard the accumulation: an absurd (bogus) version with a 10+ digit
    // major would overflow signed int — undefined behavior — and could
    // wrap to a value that slips past the >= MIN_NODE_MAJOR floor. Treat
    // an out-of-range version as unreadable.
    if (major > (INT_MAX - 9) / 10) return -1;
    major = major * 10 + (*p - '0');
    p++;
  }
  return major;
}

/* ── JS entry resolution ──────────────────────────────────────────── */

static bool resolve_talon_js(const char *exe_dir, char *out, size_t cap) {
  const char *override = getenv("TALON_JS");
  if (override != NULL && override[0] != '\0') {
    if (file_exists(override)) {
      snprintf(out, cap, "%s", override);
      return true;
    }
    fprintf(stderr, "talon: TALON_JS=%s does not exist; falling back.\n",
            override);
  }
  /*
   * The launcher normally sits in bin/ right next to talon.js. The
   * ../bin and ../lib forms cover a /usr/bin/talon shim installed beside
   * a /usr/lib/talon tree.
   */
  char candidate[PATH_MAX];
  const char *relatives[] = {
      "talon.js",
      "../bin/talon.js",
      "../lib/talon/bin/talon.js",
  };
  for (size_t i = 0; i < sizeof(relatives) / sizeof(relatives[0]); i++) {
    if (!join_path(candidate, sizeof(candidate), exe_dir, relatives[i]))
      continue;
    if (file_exists(candidate)) {
      snprintf(out, cap, "%s", candidate);
      return true;
    }
  }
  return false;
}

/* ── Node resolution ──────────────────────────────────────────────── */

/*
 * Probe one candidate node path. Returns true (and leaves `path` as the
 * winner) when it exists and is new enough; otherwise records it for
 * diagnostics and returns false. `seen`/`seen_len` dedupe so a node on
 * both PATH and a common dir isn't version-spawned twice.
 */
static bool try_node(const char *path, char seen[][PATH_MAX], size_t *seen_len,
                     size_t seen_cap) {
  for (size_t i = 0; i < *seen_len; i++) {
    if (strcmp(seen[i], path) == 0) return false;
  }
  if (*seen_len < seen_cap) {
    snprintf(seen[*seen_len], PATH_MAX, "%s", path);
    (*seen_len)++;
  }
  if (!is_executable(path)) return false;

  int major = node_major(path);
  if (major >= MIN_NODE_MAJOR) return true;
  remember_rejected(path, major);
  return false;
}

/*
 * Find a usable node, writing its path into `out`. Walks the candidate
 * list in priority order; returns false when nothing qualifies.
 */
static bool resolve_node(const char *exe_dir, char *out, size_t cap) {
  static char seen[64][PATH_MAX];
  size_t seen_len = 0;
  const size_t seen_cap = sizeof(seen) / sizeof(seen[0]);
  char cand[PATH_MAX];

#define TRY(p)                                                  \
  do {                                                          \
    if (try_node((p), seen, &seen_len, seen_cap)) {             \
      snprintf(out, cap, "%s", (p));                            \
      return true;                                              \
    }                                                           \
  } while (0)

  /*
   * (a) Explicit override is authoritative: used exactly, never
   * overridden by the implicit search. A set-but-unusable TALON_NODE is
   * a hard miss with a clear message rather than a silent fall-through
   * to some other node the user didn't ask for.
   */
  const char *talon_node = getenv("TALON_NODE");
  if (talon_node != NULL && talon_node[0] != '\0') {
    if (!is_executable(talon_node)) {
      fprintf(stderr, "talon: TALON_NODE=%s is not an executable file.\n",
              talon_node);
      return false;
    }
    int major = node_major(talon_node);
    if (major >= MIN_NODE_MAJOR) {
      snprintf(out, cap, "%s", talon_node);
      return true;
    }
    if (major < 0) {
      // Executable but `node --version` gave nothing usable — name the
      // path the user set instead of the generic "no node" advice.
      fprintf(stderr,
              "talon: TALON_NODE=%s did not report a usable version "
              "(`node --version` failed).\n",
              talon_node);
      return false;
    }
    remember_rejected(talon_node, major); /* too old — caller reports the version */
    return false;
  }

  /* (b) Vendored alongside the launcher (the bundled .deb / bottle). */
  if (join_path(cand, sizeof(cand), exe_dir, "vendor/node")) TRY(cand);
  if (join_path(cand, sizeof(cand), exe_dir, "node")) TRY(cand);

  /* (c) Everything on PATH. */
  const char *path_env = getenv("PATH");
  if (path_env != NULL) {
    char *dup = strdup(path_env);
    if (dup != NULL) {
      char *save = NULL;
      for (char *dir = strtok_r(dup, ":", &save); dir != NULL;
           dir = strtok_r(NULL, ":", &save)) {
        // Absolute dirs only. A relative PATH element (".", "bin", an
        // empty field — which also means CWD) must never cause us to
        // run a CWD-relative ./node: this binary is the front door, and
        // the cwd may be attacker-controlled.
        if (dir[0] != '/') continue;
        if (join_path(cand, sizeof(cand), dir, "node")) {
          if (try_node(cand, seen, &seen_len, seen_cap)) {
            snprintf(out, cap, "%s", cand);
            free(dup);
            return true;
          }
        }
      }
      free(dup);
    }
  }

  /*
   * (d) Common absolute install dirs + version-manager hints. PATH
   * usually covers these, but a stripped systemd/cron environment often
   * has a minimal PATH while Node lives in one of them.
   */
  const char *fixed[] = {
      "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/opt/local/bin",
      "/snap/bin",
  };
  for (size_t i = 0; i < sizeof(fixed) / sizeof(fixed[0]); i++) {
    if (join_path(cand, sizeof(cand), fixed[i], "node")) TRY(cand);
  }
  // Version-manager hints — absolute only, same CWD-relative guard.
  const char *nvm_bin = getenv("NVM_BIN");
  if (nvm_bin != NULL && nvm_bin[0] == '/' &&
      join_path(cand, sizeof(cand), nvm_bin, "node"))
    TRY(cand);
  const char *volta = getenv("VOLTA_HOME");
  if (volta != NULL && volta[0] == '/' &&
      join_path(cand, sizeof(cand), volta, "bin/node"))
    TRY(cand);

#undef TRY
  return false;
}

/* ── Diagnostics ──────────────────────────────────────────────────── */

static void report_no_node(void) {
  if (g_rejected_len == 0) {
    fprintf(stderr,
            "talon: no Node.js runtime found.\n"
            "  Talon needs Node.js >= %d. Install it, then re-run.\n"
            "    Debian/Ubuntu : https://github.com/nodesource/distributions\n"
            "    macOS (brew)  : brew install node\n"
            "    any platform  : https://nodejs.org/\n"
            "  Or point the launcher at one: TALON_NODE=/path/to/node talon\n",
            MIN_NODE_MAJOR);
    return;
  }
  /* Found node(s) but none new enough — report the newest seen. */
  struct rejected *best = NULL;
  for (size_t i = 0; i < g_rejected_len; i++) {
    if (g_rejected[i].major < 0) continue;
    if (best == NULL || g_rejected[i].major > best->major)
      best = &g_rejected[i];
  }
  if (best != NULL) {
    fprintf(stderr,
            "talon: found Node v%d at %s, but Talon needs >= %d.\n"
            "  Upgrade Node, or point the launcher at a newer one:\n"
            "    TALON_NODE=/path/to/node talon\n",
            best->major, best->path, MIN_NODE_MAJOR);
  } else {
    fprintf(stderr,
            "talon: found a `node` but couldn't read its version\n"
            "  (`node --version` failed). Check the install, or set\n"
            "  TALON_NODE=/path/to/node.\n");
  }
}

/* ── Entry point ──────────────────────────────────────────────────── */

int main(int argc, char **argv) {
  char exe_dir[PATH_MAX];
  if (!self_exe_dir(exe_dir, sizeof(exe_dir))) {
    fprintf(stderr, "talon: cannot locate own executable.\n");
    return EX_SOFTWARE;
  }

  char talon_js[PATH_MAX];
  if (!resolve_talon_js(exe_dir, talon_js, sizeof(talon_js))) {
    fprintf(stderr,
            "talon: cannot find the Talon JS entry next to this binary.\n"
            "  Looked for talon.js beside the launcher (and ../bin/talon.js).\n"
            "  Set TALON_JS=/path/to/bin/talon.js to override.\n");
    return EX_UNAVAILABLE;
  }

  char node[PATH_MAX];
  if (!resolve_node(exe_dir, node, sizeof(node))) {
    report_no_node();
    return EX_UNAVAILABLE;
  }

  /* Hand off: argv = [node, talon.js, <forwarded args...>, NULL]. */
  char **child = calloc((size_t)argc + 2, sizeof(char *));
  if (child == NULL) {
    fprintf(stderr, "talon: out of memory.\n");
    return EX_SOFTWARE;
  }
  child[0] = node;
  child[1] = talon_js;
  for (int i = 1; i < argc; i++) child[i + 1] = argv[i];
  child[argc + 1] = NULL;

  execv(node, child);

  /* execv only returns on failure. */
  fprintf(stderr, "talon: failed to exec node (%s): %s\n", node,
          strerror(errno));
  free(child);
  return EX_NOEXEC;
}

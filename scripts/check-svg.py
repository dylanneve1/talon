#!/usr/bin/env python3
"""Validate an SVG: XML well-formedness, reference integrity, geometry sanity."""

import sys
import lxml.etree as ET

NS = "http://www.w3.org/2000/svg"


def lname(el):
    return etree_localname(el)


def etree_localname(el):
    tag = el.tag
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.split("}")[-1]
    return str(tag)


def main(path):
    parser = ET.XMLParser(remove_comments=True)
    root = ET.parse(path, parser).getroot()
    if etree_localname(root) != "svg":
        sys.exit(f"root is not <svg>: {root.tag}")

    ids = [el.get("id") for el in root.iter() if el.get("id")]
    dups = sorted({i for i in ids if ids.count(i) > 1})
    print(
        f"well-formed OK; root <svg>; {len(ids)} ids; dups: {dups if dups else 'none'}"
    )

    shapes = [
        el
        for el in root.iter()
        if lname(el) in ("rect", "circle", "ellipse", "line", "path", "polygon", "use")
    ]
    print(f"renderable shapes: {len(shapes)}")

    hrefs = []
    for el in root.iter():
        for attr in ("fill", "stroke", "clip-path", "filter"):
            v = el.get(attr, "")
            if v.startswith("url(#"):
                hrefs.append(v.split("#")[1].rstrip(")"))
    missing = sorted({h for h in hrefs if h not in ids})
    print(f"url refs: {len(hrefs)} | unresolved: {missing if missing else 'none'}")

    for el in root.iter():
        h = el.get("{http://www.w3.org/1999/xlink}href") or el.get("href")
        if h and h.startswith("#"):
            assert h[1:] in ids, f"broken use/href -> {h}"
    print("use/href targets OK")

    # geometry sanity: every rendered (non-defs) shape must be on-canvas
    w, h = float(root.get("width")), float(root.get("height"))
    in_defs = False
    problems = []
    for el in root.iter():
        if lname(el) == "defs":
            in_defs = True
        elif lname(el) == "svg":
            in_defs = False
        if in_defs:
            continue
        name = lname(el)
        if name == "rect":
            x = float(el.get("x", 0))
            y = float(el.get("y", 0))
            rw = float(el.get("width", 0))
            rh = float(el.get("height", 0))
            if x < -1 or y < -1 or x + rw > w + 1 or y + rh > h + 1:
                problems.append((name, el.get("id", "?"), (x, y, rw, rh)))
        elif name in ("circle", "ellipse"):
            cx = float(el.get("cx", 0))
            cy = float(el.get("cy", 0))
            rx = float(el.get("r", el.get("rx", 0)))
            ry = float(el.get("ry", rx))
            if cx - rx < -1 or cx + rx > w + 1 or cy - ry < -1 or cy + ry > h + 1:
                problems.append((name, el.get("id", "?"), (cx, cy, rx, ry)))
    print(f"off-canvas shapes: {problems if problems else 'none'}")
    print("PASS" if not missing and not problems else "FAIL")


if __name__ == "__main__":
    main(sys.argv[1])

/**
 * Model picker rendering — select menu plus pager controls.
 *
 * The backend already paginates and filters the catalog
 * (`getSettingsPresentation` returns page / totalPages / filter / provider);
 * this only lays that out as Discord components. A select menu caps at 25
 * options, so without the pager everything past the first 25 models was
 * unreachable from the UI.
 *
 * Navigation state rides in the custom_id — `model:nav:page:3:free` — which
 * is what keeps the handler stateless across re-renders.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
} from "discord.js";
import type { ModelPickerResult } from "../../core/types.js";
import { safeSlice } from "./formatting.js";

export const MODEL_NAV_PREFIX = "model:nav";
/** Discord's hard cap on select-menu options — also the page size we request. */
export const MODEL_PAGE_SIZE = 25;

/** Where a nav button points. Decoded from a `model:nav:…` custom_id. */
export type ModelNavTarget = {
  page: number;
  filter: "all" | "free";
  provider?: string;
};

export function decodeModelNav(customId: string): ModelNavTarget | null {
  if (!customId.startsWith(`${MODEL_NAV_PREFIX}:`)) return null;
  const parts = customId.slice(MODEL_NAV_PREFIX.length + 1).split(":");
  const [kind] = parts;

  if (kind === "providers") return { page: 1, filter: "all" };
  if (kind === "provider") {
    return { page: 1, filter: "all", provider: parts[1] };
  }
  if (kind === "page") {
    const page = Number(parts[1]);
    const filter = parts[2] === "free" ? "free" : "all";
    return {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      filter,
      ...(parts[3] ? { provider: parts[3] } : {}),
    };
  }
  if (kind === "filter") {
    const filter = parts[1] === "free" ? "free" : "all";
    return { page: 1, filter, ...(parts[2] ? { provider: parts[2] } : {}) };
  }
  return null;
}

function navId(suffix: string, provider?: string): string {
  const base = `${MODEL_NAV_PREFIX}:${suffix}`;
  return provider ? `${base}:${provider}` : base;
}

/**
 * Buttons under the select: page arrows, a page counter, the free-tier
 * toggle, and a way back to the provider list. Five buttons is exactly one
 * Action Row, so this never spills into a second row.
 */
function controlRow(
  pres: ModelPickerResult,
): ActionRowBuilder<ButtonBuilder> | null {
  const buttons: ButtonBuilder[] = [];
  const { page, totalPages, filter, freeCount, provider } = pres;

  if (totalPages > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(navId(`page:${page - 1}:${filter}`, provider))
        .setLabel("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      // A disabled button is the only way to render a static counter
      // inline with the arrows.
      new ButtonBuilder()
        .setCustomId(navId("noop"))
        .setLabel(`${page}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(navId(`page:${page + 1}:${filter}`, provider))
        .setLabel("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    );
  }

  // A filter that would keep everything is just a button that does nothing —
  // offer it only when part of the catalog costs money.
  if (freeCount > 0 && freeCount < pres.totalCount) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(
          navId(`filter:${filter === "free" ? "all" : "free"}`, provider),
        )
        .setLabel(filter === "free" ? `All models` : `Free only (${freeCount})`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (provider) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(navId("providers"))
        .setLabel("← Providers")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (buttons.length === 0) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

export interface ModelPickerView {
  content: string;
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

/** Select of the backends config exposes, plus a way back to the models. */
export function buildBackendPickerView(
  backends: { id: string; label: string }[],
  currentId: string,
): ModelPickerView {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("model:backend-select")
    .setPlaceholder("Pick a backend")
    .addOptions(
      backends.map((b) => ({
        label: safeSlice(b.label || b.id, 100),
        value: safeSlice(b.id, 100),
        description: b.id === currentId ? "current" : undefined,
        default: b.id === currentId,
      })),
    );

  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(navId("page:1:all"))
      .setLabel("← Models")
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    content: [
      `**Backend:** \`${currentId}\``,
      "",
      "_Switching clears this chat's session — each backend keeps its own model pick._",
    ].join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(menu)
        .toJSON(),
      back.toJSON(),
    ],
  };
}

/**
 * Lay out one page of the picker. In the `groups` view the select lists
 * providers to drill into; in `models` it lists selectable models.
 */
export function buildModelPickerView(
  pres: ModelPickerResult,
  displayName: string,
  backendId: string,
): ModelPickerView {
  const isGroups = pres.view === "groups";
  const options = pres.modelButtons.slice(0, MODEL_PAGE_SIZE).map((b) => ({
    // Discord's own guidance is ~38 characters before a label starts
    // truncating visually, well under the 100-character hard cap.
    label: safeSlice(b.text.replace(/^✓ /, ""), 100),
    value: safeSlice(
      isGroups
        ? b.callback_data.replace(/^.*:provider:/, "provider:")
        : b.callback_data.replace(/^model:/, ""),
      100,
    ),
    default: !isGroups && b.text.startsWith("✓"),
  }));

  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] =
    [];

  if (options.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("model:select")
      .setPlaceholder(isGroups ? "Pick a provider" : "Pick a model")
      .addOptions(options);
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(menu)
        .toJSON(),
    );
  }

  const controls = controlRow(pres);
  if (controls) components.push(controls.toJSON());

  // Own row: the control row is already at Discord's five-button ceiling
  // whenever the catalog pages.
  components.push(
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(navId("backends"))
          .setLabel(`⚙ Backend: ${backendId}`)
          .setStyle(ButtonStyle.Secondary),
      )
      .toJSON(),
  );

  const scope = pres.provider ? ` · ${pres.provider}` : "";
  const counts =
    pres.totalPages > 1
      ? ` · ${pres.totalCount} model${pres.totalCount === 1 ? "" : "s"}`
      : "";
  const lines = [
    `**Model:** \`${displayName}\`${scope}${counts}`,
    ...pres.modelDetails,
  ];

  return { content: lines.join("\n"), components };
}

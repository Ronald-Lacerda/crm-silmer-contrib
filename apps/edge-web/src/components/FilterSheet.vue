<script setup>
import { nextTick, ref, useId } from 'vue';
import { openDialog } from '../lib/ui.js';
import AppIcon from './AppIcon.vue';
import AppHint from './AppHint.vue';

/**
 * RFC 024 (PLI-09, PCX-12): the less frequent filters of a list, behind one
 * "Filtros" button. A modal `dialog` gives Esc, contained focus and the
 * return of focus to the button that opened it; a tap on the backdrop closes
 * it too. On a phone it is a bottom sheet, on a wide screen a centred dialog.
 *
 * The screen owns the choices (default slot) as a draft and applies them on
 * `apply`; closing any other way leaves the list as it was. Group the choices
 * in `fieldset.filter-sheet-group` with a `legend`, one
 * `label.filter-sheet-option` around each radio or checkbox.
 */
defineProps({
  /** The sheet's heading, which also names the dialog. */
  title: { type: String, required: true },
  description: { type: String, default: '' },
  /** The single primary action: apply the draft and close. */
  applyLabel: { type: String, default: 'Ver resultados' },
  /** Resets the draft; the sheet stays open to show what changed. */
  clearLabel: { type: String, default: 'Limpar filtros' },
});
const emit = defineEmits(['apply', 'clear', 'close']);

const dialog = ref(null);
const titleId = useId();

/**
 * @param {HTMLElement} trigger the button that opened it, to get the focus
 *   back when the sheet closes.
 */
async function open(trigger) {
  const element = dialog.value;
  if (!(element instanceof HTMLDialogElement)) return;
  openDialog(element, trigger);
  // The chosen option, not the first one, is where the keyboard starts —
  // once the draft the screen just reset has reached the inputs.
  await nextTick();
  /** @type {HTMLElement|null} */ (
    element.querySelector('.filter-sheet-body input:checked')
  )?.focus();
}

function close() {
  /** @type {HTMLDialogElement|null} */ (dialog.value)?.close();
}

function apply() {
  emit('apply');
  close();
}

/** A click on the backdrop lands on the dialog itself, never on the panel. */
function closeOnBackdrop(/** @type {MouseEvent} */ event) {
  if (event.target === dialog.value) close();
}

defineExpose({ close, open });
</script>

<template>
  <dialog
    ref="dialog"
    class="filter-sheet"
    :aria-labelledby="titleId"
    @click="closeOnBackdrop"
    @close="emit('close')"
  >
    <div class="filter-sheet-panel">
      <div class="filter-sheet-head">
        <h2 :id="titleId">{{ title }}</h2>
        <button type="button" class="quiet filter-sheet-close" @click="close">
          <AppIcon name="close" /><span class="sr-only">Fechar</span>
        </button>
      </div>
      <AppHint v-if="description" class="filter-sheet-description">{{
        description
      }}</AppHint>
      <div class="filter-sheet-body">
        <slot />
      </div>
      <div class="filter-sheet-actions">
        <button type="button" class="quiet" @click="emit('clear')">
          {{ clearLabel }}
        </button>
        <button type="button" class="primary" @click="apply">
          {{ applyLabel }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<style>
/*
 * Mobile first: a sheet along the bottom edge, above the safe area, with
 * 44 px targets 8 px apart. From 48rem it is a centred dialog.
 */
.filter-sheet {
  inline-size: 100%;
  max-inline-size: 100%;
  max-block-size: 85dvh;
  margin: auto 0 0;
  padding: 0;
  color: var(--color-text);
  background: transparent;
  border: 0;
}

.filter-sheet::backdrop {
  background: var(--color-overlay);
}

.filter-sheet-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  box-sizing: border-box;
  max-block-size: 85dvh;
  padding: var(--space-4) var(--space-4)
    calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-block-end: 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--elevation-floating);
}
.filter-sheet-description {
  padding-block: var(--space-1) var(--space-3);
}
.filter-sheet-panel:has(> .filter-sheet-description) {
  grid-template-rows: auto auto minmax(0, 1fr) auto;
}

.filter-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-block-end: var(--space-2);
}

.filter-sheet-head h2 {
  margin: 0;
  font-size: var(--text-lg);
}

.filter-sheet-close {
  display: inline-grid;
  place-items: center;
  min-inline-size: var(--target-min);
  min-block-size: var(--target-min);
  padding: 0;
}

.filter-sheet-close .app-icon {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

.filter-sheet-body {
  display: grid;
  gap: var(--space-4);
  overflow-y: auto;
  padding-block: var(--space-1) var(--space-4);
  overscroll-behavior: contain;
}

.filter-sheet-group {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: 0;
}

.filter-sheet-group legend {
  margin-block-end: var(--space-1);
  padding: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.filter-sheet-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-block-size: var(--target-min);
  margin: 0;
  padding-inline: var(--space-3);
  font-size: var(--text-sm);
  font-weight: 500;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.filter-sheet-option:has(input:checked) {
  font-weight: 600;
  background: var(--color-selected);
  border-color: var(--color-focus);
}

/* Selection is neutral (design.md §3): the focus tone, never the primary. */
.filter-sheet-option input[type] {
  flex: none;
  inline-size: 1.125rem;
  block-size: 1.125rem;
  min-block-size: 0;
  margin: 0;
  accent-color: var(--color-focus);
}

.filter-sheet-actions {
  display: flex;
  gap: var(--space-2);
  padding-block-start: var(--space-3);
  border-block-start: 1px solid var(--color-border-subtle);
}

.filter-sheet-actions button {
  flex: 1 1 0;
  min-block-size: var(--target-min);
}

@media (width >= 48rem) {
  .filter-sheet {
    inline-size: min(40rem, calc(100vw - 2rem));
    margin: auto;
  }

  /* Side by side, so the groups fit a 768 px tall notebook without scroll. */
  .filter-sheet-body {
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    align-items: start;
  }

  /* 44 px with a mouse too (design.md §16), not the 40 px control height. */
  .filter-sheet-option {
    min-block-size: var(--target-min);
  }

  .filter-sheet-panel {
    padding: var(--space-6);
    border-block-end: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  .filter-sheet-actions {
    justify-content: flex-end;
  }

  .filter-sheet-actions button {
    flex: none;
    min-block-size: var(--target-min);
  }
}
</style>

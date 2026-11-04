<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

defineOptions({ inheritAttrs: false });
const props = defineProps({
  open: { type: Boolean, default: false },
  anchor: { type: Object, default: null },
  label: { type: String, required: true },
  role: { type: String, default: 'dialog' },
  align: { type: String, default: 'end' },
});
const emit = defineEmits(['update:open']);
const panel = ref(null);
let disposed = false;

function position() {
  const element = panel.value;
  const anchor = props.anchor;
  if (!(element instanceof HTMLElement) || !(anchor instanceof HTMLElement))
    return;
  if (!anchor.isConnected) {
    emit('update:open', false);
    return;
  }
  const bounds = anchor.getBoundingClientRect();
  const size = element.getBoundingClientRect();
  const margin = 12;
  const left =
    props.align === 'start' ? bounds.left : bounds.right - size.width;
  element.style.left = `${Math.max(margin, Math.min(left, innerWidth - size.width - margin))}px`;
  const below = bounds.bottom + 8;
  element.style.top = `${Math.max(margin, below + size.height <= innerHeight - margin ? below : bounds.top - size.height - 8)}px`;
}

async function synchronize() {
  await nextTick();
  if (disposed) return;
  const element = panel.value;
  if (!(element instanceof HTMLElement)) return;
  if (props.open && props.anchor instanceof HTMLElement) {
    if (!element.matches(':popover-open')) element.showPopover();
    position();
    const first = /** @type {HTMLElement | null} */ (
      element.querySelector('select, input:checked') ??
        element.querySelector('button:not(:disabled), a[href]')
    );
    first?.focus();
  } else if (element.matches(':popover-open')) element.hidePopover();
}

function toggled() {
  const element = panel.value;
  if (element instanceof HTMLElement && !element.matches(':popover-open'))
    emit('update:open', false);
}

/** @param {KeyboardEvent} event */
function keydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('update:open', false);
    props.anchor?.focus();
  }
  if (
    props.role !== 'group' ||
    !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
  )
    return;
  const buttons = /** @type {HTMLButtonElement[]} */ ([
    ...(panel.value?.querySelectorAll('button:not(:disabled)') ?? []),
  ]);
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(
    /** @type {HTMLButtonElement} */ (document.activeElement),
  );
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next]?.focus();
}

watch(() => props.open, synchronize);
watch(
  () => props.anchor,
  () => {
    if (props.open) position();
  },
);
onMounted(() => {
  globalThis.addEventListener('resize', position);
  globalThis.addEventListener('scroll', position, true);
  if (props.open) void synchronize();
});
onBeforeUnmount(() => {
  disposed = true;
  globalThis.removeEventListener('resize', position);
  globalThis.removeEventListener('scroll', position, true);
});
</script>

<template>
  <div
    v-bind="$attrs"
    ref="panel"
    class="anchored-popover"
    popover="auto"
    :role="role"
    :aria-label="label"
    @toggle="toggled"
    @keydown="keydown"
  >
    <slot />
  </div>
</template>

<style>
.anchored-popover {
  position: fixed;
  inset: auto;
  inline-size: min(18rem, calc(100vw - var(--space-6)));
  max-inline-size: calc(100vw - var(--space-6));
  max-block-size: calc(100dvh - var(--space-6));
  margin: 0;
  padding: var(--space-2);
  overflow-y: auto;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
}
.anchored-popover:not(:popover-open) {
  display: none;
}
</style>

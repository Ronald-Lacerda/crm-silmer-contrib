<script setup>
import AppIcon from './AppIcon.vue';

defineProps({
  label: { type: String, required: true },
  removeLabel: { type: String, default: '' },
});
defineEmits(['remove']);
</script>

<template>
  <button
    type="button"
    class="filter-chip"
    :aria-label="removeLabel || `Remover filtro ${label}`"
    @click="$emit('remove')"
  >
    <span>{{ label }}</span>
    <AppIcon name="close" />
  </button>
</template>

<style>
button.filter-chip {
  gap: var(--space-2);
  min-block-size: var(--control-height);
  max-inline-size: 100%;
  padding: var(--space-2) var(--space-3);
  color: var(--color-selection-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  background: var(--color-selected);
  border-color: var(--color-selection-border);
  border-radius: var(--radius-pill);
  box-shadow: none;
}
button.filter-chip:hover:not(:disabled) {
  background: var(--color-selection-hover);
  border-color: var(--color-selection-border);
}
.filter-chip > span {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.filter-chip > .app-icon {
  flex: none;
  inline-size: 1rem;
  block-size: 1rem;
}
@media (pointer: coarse), (max-width: 768px) {
  button.filter-chip {
    min-block-size: var(--target-min);
  }
}
</style>

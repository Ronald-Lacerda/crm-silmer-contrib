<script setup>
import AppIcon from './AppIcon.vue';

defineProps({
  tone: { type: String, default: 'neutral' },
});
</script>

<template>
  <p class="app-hint" :data-tone="tone">
    <AppIcon
      v-if="tone !== 'neutral'"
      :name="
        tone === 'success'
          ? 'check'
          : tone === 'warning' || tone === 'error'
            ? 'alert'
            : 'info'
      "
    />
    <span><slot /></span>
  </p>
</template>

<style>
.app-hint {
  display: flex;
  align-items: start;
  gap: var(--space-2);
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.app-hint > .app-icon {
  flex: none;
  inline-size: 1rem;
  block-size: 1rem;
  margin-block-start: 0.125rem;
}
.app-hint[data-tone='info'] {
  color: var(--status-info-text);
}
.app-hint[data-tone='warning'] {
  color: var(--status-warning-text);
}
.app-hint[data-tone='error'] {
  color: var(--status-error-text);
}
.app-hint[data-tone='success'] {
  color: var(--status-success-text);
}
.app-hint:is([data-tone='warning'], [data-tone='error']) {
  font-weight: var(--weight-medium);
}
</style>

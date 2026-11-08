import { nextTick } from 'vue';

/**
 * P1-E: after a command that takes the conversation out of the current tab,
 * the focus goes to its title, never to `body`. Shared by the reminder and
 * the outcome (loss / reopening) composables of the Inbox.
 *
 * @param {{
 *   activeId: import('vue').Ref<string>,
 *   conversationHeading: import('vue').Ref<any>,
 * }} deps
 */
export function useConversationTitleFocus({ activeId, conversationHeading }) {
  /**
   * A dialog is closed first and its own close handler (`openDialog` returns
   * the focus to the trigger) runs before this continues, so the title wins.
   * If the selection moved to another conversation meanwhile, that
   * conversation's title is not ours to focus.
   *
   * @param {HTMLDialogElement|null} [dialog]
   * @param {string} [conversationId] the conversation the command was about
   */
  async function focusConversationTitle(dialog = null, conversationId = '') {
    if (dialog?.open) {
      await new Promise((resolve) => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.close();
      });
    }
    await nextTick();
    if (conversationId && activeId.value !== conversationId) return;
    conversationHeading.value?.focus();
  }

  return { focusConversationTitle };
}

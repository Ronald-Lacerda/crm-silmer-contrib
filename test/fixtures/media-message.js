import { createApp, h, ref } from 'vue';
import MediaMessage from '/src/components/inbox/MediaMessage.vue';
import '/src/tokens.css';
import '/src/styles.css';

createApp({
  setup() {
    const params = new globalThis.URLSearchParams(globalThis.location.search);
    const kind = params.get('kind') || 'image';
    const media = ref(
      /** @type {{mediaId: string, kind: string, state: string, contentUrl: string | null}} */ ({
        mediaId: 'media-1',
        kind,
        state: params.get('state') || 'attached',
        contentUrl: params.has('unsafe')
          ? 'https://storage.invalid/private-object'
          : '/api/v1/conversations/conversation-1/media/media-1/content',
      }),
    );
    return () =>
      h('div', { style: 'max-width:640px;margin:24px auto;padding:16px' }, [
        h('h1', 'Histórico de mídia'),
        h(
          'button',
          {
            onClick: () =>
              (media.value = {
                ...media.value,
                state: 'lost',
                contentUrl: null,
              }),
          },
          'Marcar arquivo perdido',
        ),
        h(MediaMessage, {
          media: media.value,
          orders: params.has('orders')
            ? [
                { id: 'order-one', number: '01-CRM' },
                { id: 'order-two', number: '02-CRM' },
              ]
            : [],
        }),
      ]);
  },
}).mount('#app');

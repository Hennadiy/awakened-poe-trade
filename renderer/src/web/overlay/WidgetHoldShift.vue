<template>
  <Widget :config="config" move-handles="center" :inline-edit="false" :hideable="false" :removable="false">
    <button :class="$style.badge" :title="t('hold_shift.release')" @click="wm.hide(config.wmId)">
      <i class="fas fa-arrow-up" /> {{ t('hold_shift.held') }}
    </button>
  </Widget>
</template>

<script lang="ts">
import type { WidgetSpec } from './interfaces'
import type { HoldShiftWidget } from './widgets'

export default {
  widget: {
    type: 'hold-shift',
    instances: 'single',
    initInstance: (): HoldShiftWidget => {
      return {
        wmId: 0,
        wmType: 'hold-shift',
        wmTitle: '{icon=fa-arrow-up} Shift',
        wmWants: 'hide',
        wmZorder: null,
        wmFlags: [],
        anchor: {
          pos: 'tc',
          x: 50,
          y: 6
        },
        toggleKey: null
      }
    }
  } satisfies WidgetSpec
}
</script>

<script setup lang="ts">
import { inject, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MainProcess } from '@/web/background/IPC'
import { WidgetManager } from './interfaces'
import Widget from './Widget.vue'

// The widget is shown while Shift is held in the game:
// showing it (e.g. from the widget menu) holds Shift, hiding it lets go.
const props = defineProps<{
  config: HoldShiftWidget
}>()

const wm = inject<WidgetManager>('wm')!
const { t } = useI18n()

// never start the app with Shift held
if (props.config.wmWants === 'show') {
  wm.hide(props.config.wmId)
}

MainProcess.onEvent('MAIN->CLIENT::widget-action', (e) => {
  if (e.target === 'hold-shift:on') {
    wm.show(props.config.wmId)
  } else if (e.target === 'hold-shift:off') {
    wm.hide(props.config.wmId)
  }
})

watch(() => props.config.wmWants, (wants) => {
  MainProcess.sendEvent({
    name: 'CLIENT->MAIN::user-action',
    payload: { action: 'hold-shift', held: wants === 'show' }
  })
})
</script>

<style lang="postcss" module>
.badge {
  @apply bg-yellow-500 text-gray-900 font-bold rounded px-3 py-1;
  @apply leading-none whitespace-nowrap shadow;
  font-size: 1.125rem;
}
</style>

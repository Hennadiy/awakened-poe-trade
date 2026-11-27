<template>
  <div class="max-w-md p-2">
    <div class="mb-4 text-gray-400">{{ t('craft_click.about') }}</div>
    <div class="flex flex-col gap-4 mb-4">
      <HotkeysGeneric :hotkeys="hotkeys" />
    </div>
    <div class="mb-1">{{ t('craft_click.stop_pattern') }}</div>
    <textarea v-model="stopPattern" rows="2" spellcheck="false"
      class="rounded bg-gray-900 px-1 block w-full font-sans resize-none"
      placeholder='"increased Movement Speed" "\+[3-4][0-9]% to Fire"' />
    <div class="mb-4 text-sm" :class="patternError ? 'text-red-400' : 'text-gray-500'">
      {{ patternError ?? t('craft_click.pattern_help') }}
    </div>
    <div class="flex items-center gap-4 mb-4">
      <ui-checkbox v-model="sound">{{ t('craft_click.sound') }}</ui-checkbox>
      <button class="btn" @click="playCraftStopSound">{{ t('craft_click.test_sound') }}</button>
    </div>
    <div class="mb-1">{{ t('craft_click.test_item') }}</div>
    <textarea v-model="testItem" rows="4" spellcheck="false"
      class="rounded bg-gray-900 px-1 block w-full font-sans resize-y" />
    <div v-if="testResult" class="mt-1"
      :class="testResult === 'match' ? 'text-green-400' : 'text-gray-400'">{{ t(`craft_click.test_${testResult}`) }}</div>
  </div>
</template>

<script lang="ts">
export default {
  name: 'craft_click.name'
}
</script>

<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { createCraftMatcher } from '@ipc/craft-regex'
import { configProp, _configModelValue } from './utils'
import { playCraftStopSound } from '@/web/background/craft-sound'
import UiCheckbox from '@/web/ui/UiCheckbox.vue'
import HotkeysGeneric, { HotkeySchema } from './HotkeysGeneric.vue'

const props = defineProps(configProp())
const { t } = useI18n()

const hotkeys = computed<HotkeySchema[]>(() => [{
  translationKey: 'craft_click.hotkey',
  config: _configModelValue(props.config.craftClick, 'hotkey')
}])

const stopPattern = computed({
  get: () => props.config.craftClick.stopPattern,
  set: (value: string) => { props.config.craftClick.stopPattern = value.replace(/\r?\n/g, ' ') }
})
const sound = computed({
  get: () => props.config.craftClick.sound,
  set: (value: boolean) => { props.config.craftClick.sound = value }
})

const matcher = computed(() => createCraftMatcher(stopPattern.value))
const patternError = computed(() => (matcher.value instanceof Error) ? matcher.value.message : undefined)

const testItem = shallowRef('')
const testResult = computed(() => {
  const m = matcher.value
  if (!testItem.value.trim() || !m || m instanceof Error) return undefined
  return m.test(testItem.value) ? 'match' : 'no_match'
})
</script>

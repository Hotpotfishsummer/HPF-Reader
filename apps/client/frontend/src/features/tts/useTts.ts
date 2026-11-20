import { ref, shallowRef } from 'vue'

export type TtsStatus = 'idle' | 'playing' | 'paused'

export function useTts() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window
  const status = ref<TtsStatus>('idle')
  const rate = ref(1.0)
  const currentText = ref('')
  const voiceName = ref<string>('')
  const availableVoices = shallowRef<SpeechSynthesisVoice[]>([])

  function loadVoices(): void {
    if (!supported) return
    const voices = window.speechSynthesis.getVoices()
    if (voices.length > 0) {
      availableVoices.value = voices
    }
  }

  if (supported) {
    loadVoices()
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices
    }
  }

  function stop(): void {
    if (!supported) return
    window.speechSynthesis.cancel()
    status.value = 'idle'
    currentText.value = ''
  }

  function pause(): void {
    if (!supported || status.value !== 'playing') return
    window.speechSynthesis.pause()
    status.value = 'paused'
  }

  function resume(): void {
    if (!supported || status.value !== 'paused') return
    window.speechSynthesis.resume()
    status.value = 'playing'
  }

  function speak(
    text: string,
    lang = 'zh-CN',
    onEnd?: () => void,
  ): void {
    if (!supported || !text.trim()) return
    stop()

    const utterance = new SpeechSynthesisUtterance(text.trim())
    utterance.rate = rate.value
    utterance.lang = lang

    if (voiceName.value) {
      const match = availableVoices.value.find((v) => v.name === voiceName.value)
      if (match) utterance.voice = match
    } else {
      // 优先选匹配当前语言的语音
      const langMatch = availableVoices.value.find((v) => v.lang.startsWith(lang.slice(0, 2)))
      if (langMatch) utterance.voice = langMatch
    }

    utterance.onstart = () => {
      status.value = 'playing'
      currentText.value = text
    }

    utterance.onend = () => {
      status.value = 'idle'
      currentText.value = ''
      onEnd?.()
    }

    utterance.onerror = (e) => {
      console.warn('[tts] utterance error', e)
      status.value = 'idle'
      currentText.value = ''
    }

    window.speechSynthesis.speak(utterance)
  }

  return {
    supported,
    status,
    rate,
    voiceName,
    availableVoices,
    currentText,
    speak,
    pause,
    resume,
    stop,
  }
}

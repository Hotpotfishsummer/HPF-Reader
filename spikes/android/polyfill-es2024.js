/**
 * DIAGNOSTIC-ONLY polyfill for ES2024 Object.groupBy / Map.groupBy.
 *
 * This file is NOT part of the shipped application. spikes/android/run-acceptance.ps1
 * injects it through the Chrome DevTools Protocol (Page.addScriptToEvaluateOnNewDocument)
 * purely to isolate the single missing builtin reported by foliate-js on the
 * emulator WebView (Chromium 91). Everything else in the app is untouched.
 */
(function () {
  if (typeof Object.groupBy !== 'function') {
    Object.defineProperty(Object, 'groupBy', {
      configurable: true,
      writable: true,
      value: function groupBy(items, callback) {
        if (items === null || items === undefined) {
          throw new TypeError('Object.groupBy called on null or undefined')
        }
        var out = Object.create(null)
        var i = 0
        for (var item of items) {
          var key = callback(item, i++)
          if (out[key] === undefined) out[key] = []
          out[key].push(item)
        }
        return out
      },
    })
  }
  if (typeof Map.groupBy !== 'function') {
    Object.defineProperty(Map, 'groupBy', {
      configurable: true,
      writable: true,
      value: function groupBy(items, callback) {
        var out = new Map()
        var i = 0
        for (var item of items) {
          var key = callback(item, i++)
          var bucket = out.get(key)
          if (bucket === undefined) { bucket = []; out.set(key, bucket) }
          bucket.push(item)
        }
        return out
      },
    })
  }
})()

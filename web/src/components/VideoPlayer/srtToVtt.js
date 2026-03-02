/**
 * Convert SRT subtitle text to WebVTT format.
 * Prepends WEBVTT header and replaces comma with dot in timestamps.
 */
export const srtToVtt = srtText => {
  const vttBody = srtText.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${vttBody}`
}

/**
 * Fetch an SRT file, convert to VTT, and return a blob URL.
 */
export const fetchSrtAsVttBlobUrl = async srtUrl => {
  const response = await fetch(srtUrl)
  const text = await response.text()
  const vtt = srtToVtt(text)
  const blob = new Blob([vtt], { type: 'text/vtt' })
  return URL.createObjectURL(blob)
}

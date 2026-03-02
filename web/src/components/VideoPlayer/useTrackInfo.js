import { useEffect, useState } from 'react'
import axios from 'axios'
import { getTorrServerHost } from 'utils/Hosts'

const useTrackInfo = (hash, fileIndex, enabled) => {
  const [audioTracks, setAudioTracks] = useState(null)
  const [subtitleTracks, setSubtitleTracks] = useState(null)

  useEffect(() => {
    if (!enabled || !hash || fileIndex == null) return

    let cancelled = false

    axios
      .get(`${getTorrServerHost()}/ffp/${hash}/${fileIndex}`)
      .then(({ data }) => {
        if (cancelled || !data?.streams) return

        const audio = data.streams
          .filter(s => s.codec_type === 'audio')
          .map((s, i) => ({
            index: i,
            language: s.tags?.language || '',
            title: s.tags?.title || '',
            codec: s.codec_name || '',
            channels: s.channels || 0,
          }))

        const subs = data.streams
          .filter(s => s.codec_type === 'subtitle')
          .map((s, i) => ({
            index: i,
            language: s.tags?.language || '',
            title: s.tags?.title || '',
            codec: s.codec_name || '',
          }))

        setAudioTracks(audio.length ? audio : null)
        setSubtitleTracks(subs.length ? subs : null)
      })
      .catch(() => {
        // ffprobe unavailable — silently ignore
      })

    return () => {
      cancelled = true
    }
  }, [hash, fileIndex, enabled])

  return { audioTracks, subtitleTracks }
}

export default useTrackInfo

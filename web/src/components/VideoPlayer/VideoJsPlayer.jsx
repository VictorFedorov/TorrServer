import { useEffect, useRef } from 'react'
import videojs from 'video.js'
import 'video.js/dist/video-js.css'
import './videojs-torrserver-theme.css'

const VideoJsPlayer = ({ options, onReady }) => {
  const videoRef = useRef(null)
  const playerRef = useRef(null)

  useEffect(() => {
    if (playerRef.current) return

    const videoElement = videoRef.current
    if (!videoElement) return

    const player = videojs(videoElement, options, () => {
      onReady?.(player)
    })
    playerRef.current = player

    return () => {
      if (playerRef.current) {
        playerRef.current.dispose()
        playerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div data-vjs-player>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Video.js manages tracks dynamically */}
      <video ref={videoRef} className='video-js vjs-big-play-centered' />
    </div>
  )
}

export default VideoJsPlayer

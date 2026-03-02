import { useCallback, useState } from 'react'
import { Box, CircularProgress, DialogContent, DialogTitle, IconButton, Typography, useMediaQuery } from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import CloseIcon from '@material-ui/icons/Close'
import PlayArrowIcon from '@material-ui/icons/PlayArrow'
import videojs from 'video.js'
import { useTranslation } from 'react-i18next'
import { StyledDialog } from 'style/CustomMaterialUiStyles'

import { StyledButton } from '../TorrentCard/style'
import VideoJsPlayer from './VideoJsPlayer'
import useTrackInfo from './useTrackInfo'
import { fetchSrtAsVttBlobUrl } from './srtToVtt'
import { getTorrServerHost } from 'utils/Hosts'

function getTranscodeUrl(hash, fileIndex, seekTime) {
  const base = `${getTorrServerHost()}/transcode/${hash}/${fileIndex}`
  return seekTime ? `${base}?t=${seekTime}` : base
}

function getMimeType(url) {
  const ext = url.split('?')[0].split('.').pop().toLowerCase()
  const types = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    ogv: 'video/ogg',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    mov: 'video/quicktime',
  }
  return types[ext] || ''
}

// Register a custom Download button component for Video.js
const VjsButton = videojs.getComponent('Button')

class DownloadButton extends VjsButton {
  constructor(player, options) {
    super(player, options)
    this.controlText('Download')
    this.addClass('vjs-download-button')
  }

  handleClick() {
    const src = this.player().currentSrc()
    if (!src) return
    const a = document.createElement('a')
    a.href = src
    a.download = ''
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  buildCSSClass() {
    return `vjs-download-button ${super.buildCSSClass()}`
  }
}

videojs.registerComponent('DownloadButton', DownloadButton)

const useStyles = makeStyles(theme => ({
  dialogPaper: {
    backgroundColor: '#fff',
    borderRadius: theme.spacing(1),
  },
  header: {
    backgroundColor: '#00a572',
    color: '#fff',
    padding: theme.spacing(1, 2),
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  iconButton: {
    color: '#fff',
    '&:hover': { backgroundColor: 'rgba(255,255,255,0.1)' },
  },
  content: {
    padding: 0,
    backgroundColor: '#000',
    '& .video-js': {
      width: '100%',
      height: '100%',
    },
  },
}))

const VideoPlayer = ({ videoSrc, title, onNotSupported, hash, fileIndex, subtitleSources = [], renderTrigger }) => {
  const classes = useStyles()
  const isMobile = useMediaQuery('@media (max-width:930px)')
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const { audioTracks: ffprobeAudio, needsTranscode, duration: ffprobeDuration, loaded: trackInfoLoaded } = useTrackInfo(hash, fileIndex, open)
  const playerReady = !open || trackInfoLoaded || !hash || fileIndex == null

  const handleClose = useCallback(() => setOpen(false), [])

  const handleReady = useCallback(
    player => {
      // Add external subtitle tracks (SRT -> VTT conversion)
      if (subtitleSources.length) {
        subtitleSources.forEach(sub => {
          const isSrt = /\.srt$/i.test(sub.src)
          if (isSrt) {
            fetchSrtAsVttBlobUrl(sub.src).then(blobUrl => {
              player.addRemoteTextTrack(
                {
                  kind: 'subtitles',
                  srclang: sub.srclang || 'und',
                  label: sub.label || 'Subtitle',
                  src: blobUrl,
                },
                false,
              )
            })
          } else {
            player.addRemoteTextTrack(
              {
                kind: 'subtitles',
                srclang: sub.srclang || 'und',
                label: sub.label || 'Subtitle',
                src: sub.src,
              },
              false,
            )
          }
        })
      }

      // Enhance audio track labels from ffprobe data when available
      const enhanceAudioLabels = () => {
        if (!ffprobeAudio) return
        const playerAudioTracks = player.audioTracks()
        for (let i = 0; i < playerAudioTracks.length; i++) {
          const track = playerAudioTracks[i]
          const info = ffprobeAudio[i]
          if (info) {
            const parts = []
            if (info.title) parts.push(info.title)
            else if (info.language) parts.push(info.language.toUpperCase())
            if (info.codec) parts.push(info.codec)
            if (info.channels) parts.push(`${info.channels}ch`)
            if (parts.length) track.label = parts.join(' - ')
          }
        }
      }
      enhanceAudioLabels()
      player.audioTracks().addEventListener('addtrack', enhanceAudioLabels)

      // For transcoded streams: custom duration and seeking.
      // Fragmented MP4 has no duration in metadata and the browser only allows
      // seeking within the buffered range. We override currentTime() to track
      // a seek offset and intercept all seeks to restart ffmpeg from that point.
      if (needsTranscode && hash && fileIndex != null) {
        let seekOffset = 0
        let changingSource = false

        const forceDuration = () => {
          if (ffprobeDuration && player.duration() !== ffprobeDuration) {
            player.duration(ffprobeDuration)
          }
          player.removeClass('vjs-live')
        }

        if (ffprobeDuration) {
          forceDuration()
          player.on('loadedmetadata', forceDuration)
          player.on('durationchange', forceDuration)
          player.on('loadeddata', forceDuration)
          player.on('timeupdate', forceDuration)
        }

        // Override currentTime: getter adds offset, setter triggers source change
        const origCurrentTime = player.currentTime.bind(player)
        // eslint-disable-next-line no-param-reassign
        player.currentTime = function (seconds) {
          if (arguments.length > 0) {
            if (changingSource) return origCurrentTime(seconds)
            const targetTime = Math.floor(seconds)
            const currentAbsolute = Math.floor(origCurrentTime() + seekOffset)
            // Only restart ffmpeg for seeks > 2 seconds away
            if (Math.abs(targetTime - currentAbsolute) > 2 && ffprobeDuration) {
              changingSource = true
              seekOffset = targetTime
              player.src({ src: getTranscodeUrl(hash, fileIndex, targetTime), type: 'video/mp4' })
              forceDuration()
              player.play()
              player.one('playing', () => { changingSource = false })
              setTimeout(() => { changingSource = false }, 10000)
              return
            }
            return origCurrentTime(seconds)
          }
          // Getter: real stream position + offset
          return origCurrentTime() + seekOffset
        }
      }

      // Handle playback errors (codec not supported)
      player.on('error', () => {
        const error = player.error()
        if (error && (error.code === 3 || error.code === 4)) {
          onNotSupported?.()
          setOpen(false)
        }
      })
    },
    [subtitleSources, ffprobeAudio, needsTranscode, ffprobeDuration, hash, fileIndex, onNotSupported],
  )

  const useTranscode = needsTranscode && hash && fileIndex != null
  const effectiveSrc = useTranscode ? getTranscodeUrl(hash, fileIndex) : videoSrc
  const effectiveMime = useTranscode ? 'video/mp4' : getMimeType(videoSrc)

  const playerOptions = {
    autoplay: 'any',
    controls: true,
    responsive: true,
    fluid: true,
    playbackRates: [0.5, 1, 1.5, 2],
    sources: [{ src: effectiveSrc, type: effectiveMime || undefined }],
    controlBar: {
      children: [
        'playToggle',
        'volumePanel',
        'currentTimeDisplay',
        'timeDivider',
        'durationDisplay',
        'progressControl',
        'remainingTimeDisplay',
        'playbackRateMenuButton',
        'audioTrackButton',
        'subsCapsButton',
        'pictureInPictureToggle',
        'DownloadButton',
        'fullscreenToggle',
      ],
    },
  }

  const defaultTrigger = (
    <StyledButton onClick={() => setOpen(true)}>
      <PlayArrowIcon />
      <span>{t('Play')}</span>
    </StyledButton>
  )

  return (
    <>
      {renderTrigger ? renderTrigger(() => setOpen(true)) : defaultTrigger}

      {open && (
        <StyledDialog
          open
          onClose={handleClose}
          maxWidth='lg'
          fullWidth
          fullScreen={isMobile}
          classes={{ paper: classes.dialogPaper }}
        >
          <DialogTitle className={classes.header} disableTypography>
            <Typography variant='h6' noWrap>
              {title || 'Video Player'}
            </Typography>
            <IconButton size='medium' onClick={handleClose} className={classes.iconButton}>
              <CloseIcon fontSize='medium' />
            </IconButton>
          </DialogTitle>
          <DialogContent className={classes.content}>
            {playerReady ? (
              <VideoJsPlayer options={playerOptions} onReady={handleReady} />
            ) : (
              <Box display='flex' justifyContent='center' alignItems='center' minHeight={300}>
                <CircularProgress style={{ color: '#fff' }} />
              </Box>
            )}
          </DialogContent>
        </StyledDialog>
      )}
    </>
  )
}

export default VideoPlayer

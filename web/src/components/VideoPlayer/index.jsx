import { useCallback, useRef, useState } from 'react'
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
  const seekingRef = useRef(false)

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

      // For transcoded streams: set duration from ffprobe and handle seeking
      if (needsTranscode && hash && fileIndex != null) {
        if (ffprobeDuration) {
          // Force duration from ffprobe data.
          // Fragmented MP4 streams report no duration in metadata, so the browser
          // gives Infinity which Video.js converts to seekable.end(0) — a small
          // number based on buffered data. We must always override this.
          const forceDuration = () => {
            if (player.duration() !== ffprobeDuration) {
              player.duration(ffprobeDuration)
            }
            // Ensure progress bar is visible (not live mode)
            player.removeClass('vjs-live')
          }

          forceDuration()
          player.on('loadedmetadata', forceDuration)
          player.on('durationchange', forceDuration)
          player.on('loadeddata', forceDuration)
          // timeupdate fires regularly (~250ms) and acts as a persistent guard
          player.on('timeupdate', forceDuration)
        }

        player.on('seeking', () => {
          if (seekingRef.current) return
          seekingRef.current = true
          const time = Math.floor(player.currentTime())
          player.src({ src: getTranscodeUrl(hash, fileIndex, time), type: 'video/mp4' })
          if (ffprobeDuration) player.duration(ffprobeDuration)
          player.play()
          seekingRef.current = false
        })
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

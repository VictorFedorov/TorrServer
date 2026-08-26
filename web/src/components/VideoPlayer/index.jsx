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
    // Cap dialog height so the fluid video-js player can't push content
    // past the viewport. 95vh leaves a bit of breathing room.
    maxHeight: '95vh',
    // Kill any internal scroll on the paper itself. The dialog holds a
    // fluid video player, not scrollable content.
    overflow: 'hidden',
    // Make paper a column flex container so DialogContent can flex-1
    // into the remaining space below the header.
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    backgroundColor: '#00a572',
    color: '#fff',
    padding: theme.spacing(1, 2),
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    // Don't let the header collapse — it has a fixed height, so the
    // remaining space goes to the video content.
    flexShrink: 0,
  },
  iconButton: {
    color: '#fff',
    '&:hover': { backgroundColor: 'rgba(255,255,255,0.1)' },
  },
  content: {
    padding: 0,
    backgroundColor: '#000',
    // MuiDialogContent default is overflow-y: auto, which produces the
    // resize loop: player renders bigger than the remaining space,
    // browser adds an inner scrollbar, that narrows the container,
    // fluid player recomputes and shrinks, scrollbar goes away, repeat.
    // The player fits or it doesn't — no scroll needed.
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Let the player take all the vertical space left by the header
    // inside the 95vh-capped paper.
    flex: 1,
    minHeight: 0,
    '& .video-js': {
      width: '100%',
      // Height auto lets video.js fluid-mode manage aspect ratio,
      // instead of fighting a hard-coded 100% height.
      height: 'auto',
      maxHeight: '100%',
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

        // Patch player.duration() to always return ffprobeDuration.
        // The fMP4 stream has no `mvhd.duration` (empty_moov), so
        // video.js sees duration=Infinity and enters live-UI mode:
        // the progress thumb snaps to the right edge, jumps back on
        // the next timeupdate, snaps forward again. Serving a fixed
        // duration everywhere the framework asks kills the live-mode
        // heuristic at the source, so we no longer need the reactive
        // removeClass('vjs-live') on every timeupdate.
        if (ffprobeDuration) {
          const origDuration = player.duration.bind(player)
          // eslint-disable-next-line no-param-reassign
          player.duration = function (value) {
            if (arguments.length > 0) return origDuration(value)
            return ffprobeDuration
          }
          player.removeClass('vjs-live')
          // Nudge video.js once so it recomputes the progress bar
          // against the new duration.
          player.trigger('durationchange')
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
              // player.duration() is now patched to always return
              // ffprobeDuration, so no explicit forceDuration call needed
              // — the new source picks up the correct value on load.
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

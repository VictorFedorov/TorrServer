package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"

	"github.com/gin-gonic/gin"

	"server/log"
	sets "server/settings"
	"server/torr"
	"server/torr/state"
	"server/web/api/utils"
)

// transcode godoc
//
//	@Summary		Transcode torrent stream (audio AC3/EAC3/DTS → AAC)
//	@Description	Serves torrent file with audio transcoded to AAC via ffmpeg. Video is copied without re-encoding.
//
//	@Tags			API
//
//	@Param			hash	path	string	true	"Torrent infohash"
//	@Param			id		path	string	true	"File index in torrent"
//	@Param			t		query	string	false	"Seek time in seconds"
//
//	@Produce		video/mp4
//	@Success		200	"Transcoded stream"
//	@Router			/transcode/{hash}/{id} [get]
func transcode(c *gin.Context) {
	hash := c.Param("hash")
	indexStr := c.Param("id")

	if hash == "" || indexStr == "" {
		c.AbortWithError(http.StatusNotFound, errors.New("no infohash or file index"))
		return
	}

	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		c.AbortWithError(http.StatusServiceUnavailable, errors.New("ffmpeg not found"))
		return
	}

	spec, err := utils.ParseLink(hash)
	if err != nil {
		c.AbortWithError(http.StatusInternalServerError, err)
		return
	}

	tor := torr.GetTorrent(spec.InfoHash.HexString())
	if tor == nil {
		c.AbortWithError(http.StatusNotFound, errors.New("torrent not found"))
		return
	}

	if tor.Stat == state.TorrentInDB {
		tor, err = torr.AddTorrent(spec, tor.Title, tor.Poster, tor.Data, tor.Category)
		if err != nil {
			c.AbortWithError(http.StatusInternalServerError, err)
			return
		}
	}

	if !tor.GotInfo() {
		c.AbortWithError(http.StatusInternalServerError, errors.New("torrent connection timeout"))
		return
	}

	// Loopback URL to /play endpoint (same pattern as ffprobe.go)
	playURL := "http://127.0.0.1:" + sets.Port + "/play/" + hash + "/" + indexStr
	if sets.Ssl {
		playURL = "https://127.0.0.1:" + sets.SslPort + "/play/" + hash + "/" + indexStr
	}

	seekTime := c.DefaultQuery("t", "0")
	if _, err := strconv.ParseFloat(seekTime, 64); err != nil {
		seekTime = "0"
	}

	args := []string{}
	if seekTime != "0" {
		args = append(args, "-ss", seekTime)
	}
	args = append(args,
		"-i", playURL,
		"-c:v", "copy",
		"-c:a", "aac",
		"-b:a", "192k",
		"-ac", "2",
		"-f", "mp4",
		"-movflags", "empty_moov+frag_keyframe+default_base_moof",
		"pipe:1",
	)

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, ffmpegPath, args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		c.AbortWithError(http.StatusInternalServerError, fmt.Errorf("ffmpeg stdout pipe: %v", err))
		return
	}

	log.TLogln("Transcode start:", hash, indexStr, "seek:", seekTime)

	if err := cmd.Start(); err != nil {
		c.AbortWithError(http.StatusInternalServerError, fmt.Errorf("ffmpeg start: %v", err))
		return
	}

	c.Header("Content-Type", "video/mp4")
	c.Header("Cache-Control", "no-cache")
	c.Status(http.StatusOK)

	if _, err := io.Copy(c.Writer, stdout); err != nil {
		log.TLogln("Transcode stream ended:", err)
	}

	cmd.Wait()
	log.TLogln("Transcode done:", hash, indexStr)
}

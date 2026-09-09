package utils

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"server/log"
	"server/settings"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"golang.org/x/time/rate"
)

var defTrackers = []string{
	"http://retracker.local/announce",
	"http://bt4.t-ru.org/ann?magnet",
	"http://retracker.mgts.by:80/announce",
	"http://tracker.city9x.com:2710/announce",
	"http://tracker.electro-torrent.pl:80/announce",
	"http://tracker.internetwarriors.net:1337/announce",
	"http://tracker2.itzmx.com:6961/announce",
	"udp://opentor.org:2710",
	"udp://public.popcorn-tracker.org:6969/announce",
	"udp://tracker.opentrackr.org:1337/announce",
	"http://bt.svao-ix.ru/announce",
	"udp://explodie.org:6969/announce",
	"wss://tracker.btorrent.xyz",
	"wss://tracker.openwebtorrent.com",
}

var (
	loadedTrackers       []string
	loadTrackersOnce     sync.Once
	trackersListURL      = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt"
	trackersFetchTimeout = 5 * time.Second
)

func GetTrackerFromFile() []string {
	name := filepath.Join(settings.Path, "trackers.txt")
	buf, err := os.ReadFile(name)
	if err == nil {
		list := strings.Split(string(buf), "\n")
		var ret []string
		for _, l := range list {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "udp") || strings.HasPrefix(l, "http") {
				ret = append(ret, l)
			}
		}
		return ret
	}
	return nil
}

func GetDefTrackers() []string {
	loadNewTracker()
	if len(loadedTrackers) == 0 {
		return defTrackers
	}
	return loadedTrackers
}

func loadNewTracker() {
	// Once + sticky fallback: try the remote list at most once per
	// process lifetime. In RU/CN networks GitHub is regularly RST-ed
	// at TCP level; the previous unbounded http.Get would hang the
	// caller for kernel-level default (~130s) on every torrent add.
	// If the fetch fails, loadedTrackers stays empty and
	// GetDefTrackers falls back to the built-in defTrackers list.
	loadTrackersOnce.Do(func() {
		client := &http.Client{Timeout: trackersFetchTimeout}
		resp, err := client.Get(trackersListURL)
		if err != nil {
			log.TLogln("trackerslist fetch failed, using built-in trackers:", err.Error())
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			log.TLogln("trackerslist fetch failed, using built-in trackers:", fmt.Sprintf("status %d", resp.StatusCode))
			return
		}
		buf, err := io.ReadAll(resp.Body)
		if err != nil {
			log.TLogln("trackerslist fetch failed, using built-in trackers:", err.Error())
			return
		}
		arr := strings.Split(string(buf), "\n")
		var ret []string
		for _, s := range arr {
			s = strings.TrimSpace(s)
			if len(s) > 0 {
				ret = append(ret, s)
			}
		}
		if len(ret) == 0 {
			log.TLogln("trackerslist fetch failed, using built-in trackers: empty list")
			return
		}
		loadedTrackers = append(ret, defTrackers...)
	})
}

// resetLoadedTrackersForTest clears cached trackers so tests can re-run loadNewTracker.
func resetLoadedTrackersForTest() {
	loadTrackersOnce = sync.Once{}
	loadedTrackers = nil
}

func PeerIDRandom(peer string) string {
	randomBytes := make([]byte, 32)
	_, err := rand.Read(randomBytes)
	if err != nil {
		panic(err)
	}
	return peer + base32.StdEncoding.EncodeToString(randomBytes)[:20-len(peer)]
}

func Limit(i int) *rate.Limiter {
	l := rate.NewLimiter(rate.Inf, 0)
	if i > 0 {
		b := i
		if b < 16*1024 {
			b = 16 * 1024
		}
		l = rate.NewLimiter(rate.Limit(i), b)
	}
	return l
}

func OpenTorrentFile(path string) (*torrent.TorrentSpec, error) {
	minfo, err := metainfo.LoadFromFile(path)
	if err != nil {
		return nil, err
	}
	info, err := minfo.UnmarshalInfo()
	if err != nil {
		return nil, err
	}

	// mag := minfo.Magnet(info.Name, minfo.HashInfoBytes())
	mag := minfo.Magnet(nil, &info)
	return &torrent.TorrentSpec{
		InfoBytes:   minfo.InfoBytes,
		Trackers:    [][]string{mag.Trackers},
		DisplayName: info.Name,
		InfoHash:    minfo.HashInfoBytes(),
	}, nil
}

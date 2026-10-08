package torrstor

import (
	"sync"
	"testing"

	"github.com/anacrolix/torrent/metainfo"

	"server/settings"
)

func testInfo() *metainfo.Info {
	return &metainfo.Info{
		Name:        "test",
		PieceLength: 1 << 10,
		Length:      1 << 20,
		Pieces:      make([]byte, (1<<10)*20),
	}
}

func initTestSettings(t *testing.T) {
	if settings.BTsets == nil {
		settings.BTsets = &settings.BTSets{}
		t.Cleanup(func() { settings.BTsets = nil })
	}
}

// Storage.caches: anacrolix-driven Cache.Close (delete) racing
// OpenTorrent/GetCache from other goroutines.
func TestStorageCachesConcurrentOpenClose(t *testing.T) {
	initTestSettings(t)
	stor := NewStorage(1 << 20)

	var wg sync.WaitGroup
	const iters = 500

	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < iters; i++ {
			var h metainfo.Hash
			h[0] = byte(i)
			stor.OpenTorrent(testInfo(), h)
			cache := stor.GetCache(h)
			if cache != nil {
				// anacrolix calls TorrentImpl.Close from its own goroutine
				cache.Close()
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < iters; i++ {
			var h metainfo.Hash
			h[0] = byte(i)
			stor.GetCache(h)
			var h2 metainfo.Hash
			h2[0] = byte(i)
			h2[1] = 1
			stor.OpenTorrent(testInfo(), h2)
			stor.CloseHash(h2)
		}
	}()
	wg.Wait()
}

// Cache.pieces: GetState/cleanPieces iterating while Close nils the map.
func TestCachePiecesConcurrentStateClose(t *testing.T) {
	initTestSettings(t)

	var wg sync.WaitGroup
	const iters = 300

	for i := 0; i < iters; i++ {
		stor := NewStorage(1 << 20)
		var h metainfo.Hash
		h[0] = byte(i)
		stor.OpenTorrent(testInfo(), h)
		cache := stor.GetCache(h)

		wg.Add(2)
		go func() {
			defer wg.Done()
			cache.GetState()
			cache.cleanPieces()
		}()
		go func() {
			defer wg.Done()
			cache.Close()
		}()
		wg.Wait()
	}
}

// anacrolix reruns setInfo when InfoBytes are added to a live torrent: the open cache must be reused.
func TestStorageOpenTorrentTwiceReusesCache(t *testing.T) {
	initTestSettings(t)
	stor := NewStorage(1 << 20)
	var h metainfo.Hash

	first, _ := stor.OpenTorrent(testInfo(), h)
	second, _ := stor.OpenTorrent(testInfo(), h)
	if first != second {
		t.Fatal("second OpenTorrent created a new cache instead of reusing the open one")
	}

	stor.CloseHash(h)
	third, _ := stor.OpenTorrent(testInfo(), h)
	if third == first {
		t.Fatal("OpenTorrent after close returned the closed cache")
	}
	stor.CloseHash(h)
}

// A closed cache may stay reachable from anacrolix: Close must free piece buffers and later writes must not allocate.
func TestCacheCloseReleasesMemPieces(t *testing.T) {
	initTestSettings(t)
	stor := NewStorage(1 << 20)
	var h metainfo.Hash
	stor.OpenTorrent(testInfo(), h)
	cache := stor.GetCache(h)

	chunk := make([]byte, 1<<10)
	cache.pieces[0].WriteAt(chunk, 0)
	if !cache.pieces[0].mPiece.isAllocated() {
		t.Fatal("piece buffer was not allocated by WriteAt")
	}

	cache.Close()
	if cache.pieces[0].mPiece.isAllocated() {
		t.Fatal("Close kept the piece buffer")
	}

	if n, _ := cache.pieces[1].WriteAt(chunk, 0); n != len(chunk) {
		t.Fatalf("WriteAt after Close returned %d, want %d", n, len(chunk))
	}
	if cache.pieces[1].mPiece.isAllocated() {
		t.Fatal("WriteAt after Close allocated a buffer")
	}
}

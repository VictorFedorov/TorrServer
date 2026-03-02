package torr

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
)

const (
	lpdMulticastAddr = "239.192.152.143:6771"
	lpdAnnounceInt   = 5 * time.Minute
	lpdMaxPacketSize = 1400
	lpdMaxPerPacket  = 30
)

// LPD implements BEP 14 Local Peer Discovery via UDP multicast.
type LPD struct {
	bt     *BTServer
	cookie string
	conn   *net.UDPConn
	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewLPD(bt *BTServer) *LPD {
	b := make([]byte, 8)
	rand.Read(b)
	return &LPD{
		bt:     bt,
		cookie: hex.EncodeToString(b),
		stopCh: make(chan struct{}),
	}
}

func (l *LPD) Start() error {
	addr, err := net.ResolveUDPAddr("udp4", lpdMulticastAddr)
	if err != nil {
		return fmt.Errorf("lpd resolve: %w", err)
	}

	l.conn, err = net.ListenMulticastUDP("udp4", nil, addr)
	if err != nil {
		return fmt.Errorf("lpd listen: %w", err)
	}
	l.conn.SetReadBuffer(64 * 1024)

	log.Println("LPD started on", lpdMulticastAddr)

	l.wg.Add(2)
	go l.listen()
	go l.announce()
	return nil
}

func (l *LPD) Stop() {
	close(l.stopCh)
	if l.conn != nil {
		l.conn.Close()
	}
	l.wg.Wait()
	log.Println("LPD stopped")
}

func (l *LPD) listen() {
	defer l.wg.Done()
	buf := make([]byte, 2048)
	for {
		select {
		case <-l.stopCh:
			return
		default:
		}

		l.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, src, err := l.conn.ReadFromUDP(buf)
		if err != nil {
			if nerr, ok := err.(net.Error); ok && nerr.Timeout() {
				continue
			}
			select {
			case <-l.stopCh:
				return
			default:
				log.Println("LPD read error:", err)
				continue
			}
		}

		cookie, port, infohashes := parseLPDPacket(buf[:n])
		if cookie == "" || cookie == l.cookie {
			continue // skip own announces or invalid packets
		}
		if port <= 0 || port > 65535 {
			continue
		}

		peerIP := src.IP
		for _, hashHex := range infohashes {
			var hash metainfo.Hash
			b, err := hex.DecodeString(hashHex)
			if err != nil || len(b) != 20 {
				continue
			}
			copy(hash[:], b)

			t := l.bt.GetTorrent(torrent.InfoHash(hash))
			if t == nil || t.Torrent == nil {
				continue
			}

			t.AddPeers([]torrent.Peer{
				{
					IP:   peerIP,
					Port: port,
				},
			})
			log.Printf("LPD: added peer %s:%d for %s", peerIP, port, hashHex)
		}
	}
}

func (l *LPD) announce() {
	defer l.wg.Done()

	// Initial announce after short delay
	select {
	case <-time.After(10 * time.Second):
	case <-l.stopCh:
		return
	}
	l.sendAnnounces()

	ticker := time.NewTicker(lpdAnnounceInt)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			l.sendAnnounces()
		case <-l.stopCh:
			return
		}
	}
}

func (l *LPD) sendAnnounces() {
	if l.bt.client == nil {
		return
	}
	port := l.bt.client.LocalPort()
	if port == 0 {
		return
	}

	torrents := l.bt.ListTorrents()
	var hashes []string
	for hash, t := range torrents {
		if t.Torrent != nil {
			hashes = append(hashes, hash.HexString())
		}
	}
	if len(hashes) == 0 {
		return
	}

	// Batch hashes to stay under packet size limit
	for i := 0; i < len(hashes); i += lpdMaxPerPacket {
		end := i + lpdMaxPerPacket
		if end > len(hashes) {
			end = len(hashes)
		}
		l.sendAnnounce(hashes[i:end], port)
	}
}

func (l *LPD) sendAnnounce(hashes []string, port int) {
	var sb strings.Builder
	sb.WriteString("BT-SEARCH * HTTP/1.1\r\n")
	sb.WriteString("Host: " + lpdMulticastAddr + "\r\n")
	sb.WriteString(fmt.Sprintf("Port: %d\r\n", port))
	for _, h := range hashes {
		sb.WriteString("Infohash: " + h + "\r\n")
	}
	sb.WriteString("cookie: " + l.cookie + "\r\n")
	sb.WriteString("\r\n")

	data := []byte(sb.String())
	if len(data) > lpdMaxPacketSize {
		log.Println("LPD: announce packet too large, skipping")
		return
	}

	dst, err := net.ResolveUDPAddr("udp4", lpdMulticastAddr)
	if err != nil {
		log.Println("LPD send resolve error:", err)
		return
	}

	conn, err := net.DialUDP("udp4", nil, dst)
	if err != nil {
		log.Println("LPD send error:", err)
		return
	}
	defer conn.Close()

	if _, err := conn.Write(data); err != nil {
		log.Println("LPD send error:", err)
	}
}

// parseLPDPacket parses a BEP 14 BT-SEARCH packet.
func parseLPDPacket(data []byte) (cookie string, port int, infohashes []string) {
	lines := strings.Split(string(data), "\r\n")
	if len(lines) < 2 {
		return
	}

	// First line must be the BT-SEARCH request line
	if !strings.HasPrefix(lines[0], "BT-SEARCH ") {
		return
	}

	for _, line := range lines[1:] {
		if line == "" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])

		switch strings.ToLower(key) {
		case "port":
			fmt.Sscanf(val, "%d", &port)
		case "infohash":
			if len(val) == 40 {
				infohashes = append(infohashes, strings.ToLower(val))
			}
		case "cookie":
			cookie = val
		}
	}
	return
}

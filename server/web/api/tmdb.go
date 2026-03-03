package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/proxy"

	"server/log"
	sets "server/settings"
)

// tmdbSettings godoc
//
//	@Summary		Get TMDB settings
//	@Description	Get TMDB API configuration
//
//	@Tags			API
//
//	@Produce		json
//	@Success		200	{object}	sets.TMDBConfig	"TMDB settings"
//	@Router			/tmdb/settings [get]
func tmdbSettings(c *gin.Context) {
	if sets.BTsets == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Settings not initialized"})
		return
	}
	c.JSON(200, sets.BTsets.TMDBSettings)
}

type tmdbSearchRequest struct {
	Query    string `json:"query"`
	Language string `json:"language"`
}

type tmdbSearchResult struct {
	PosterURL string `json:"poster_url"`
	MediaType string `json:"media_type"`
}

type tmdbAPIResult struct {
	PosterPath string `json:"poster_path"`
	MediaType  string `json:"media_type"`
}

type tmdbAPIResponse struct {
	Results []tmdbAPIResult `json:"results"`
}

// buildTMDBClient creates an HTTP client, optionally with SOCKS5/HTTP proxy
func buildTMDBClient(proxyURL string) *http.Client {
	timeout := 15 * time.Second

	if proxyURL == "" {
		return &http.Client{Timeout: timeout}
	}

	parsed, err := url.Parse(proxyURL)
	if err != nil {
		log.TLogln("TMDB: invalid proxy URL:", err)
		return &http.Client{Timeout: timeout}
	}

	scheme := strings.ToLower(parsed.Scheme)

	if scheme == "socks5" || scheme == "socks5h" {
		var auth *proxy.Auth
		if parsed.User != nil {
			pass, _ := parsed.User.Password()
			auth = &proxy.Auth{
				User:     parsed.User.Username(),
				Password: pass,
			}
		}
		dialer, err := proxy.SOCKS5("tcp", parsed.Host, auth, proxy.Direct)
		if err != nil {
			log.TLogln("TMDB: failed to create SOCKS5 dialer:", err)
			return &http.Client{Timeout: timeout}
		}
		transport := &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dialer.Dial(network, addr)
			},
		}
		return &http.Client{Transport: transport, Timeout: timeout}
	}

	// HTTP/HTTPS proxy
	transport := &http.Transport{
		Proxy: http.ProxyURL(parsed),
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

// tmdbSearch godoc
//
//	@Summary		Search TMDB for posters
//	@Description	Proxy search request to TMDB API and return poster URLs
//
//	@Tags			API
//
//	@Accept			json
//	@Produce		json
//	@Param			request	body		tmdbSearchRequest	true	"Search query"
//	@Success		200		{array}		tmdbSearchResult	"Search results with poster URLs and media types"
//	@Router			/tmdb/search [post]
func tmdbSearch(c *gin.Context) {
	if sets.BTsets == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Settings not initialized"})
		return
	}

	var req tmdbSearchRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "query is required"})
		return
	}

	tmdb := sets.BTsets.TMDBSettings
	if tmdb.APIKey == "" {
		c.JSON(http.StatusOK, []tmdbSearchResult{})
		return
	}

	if req.Language == "" {
		req.Language = "en"
	}

	// Build TMDB API URL
	apiBase := strings.TrimRight(tmdb.APIURL, "/")
	if !strings.HasSuffix(apiBase, "/3") {
		apiBase += "/3"
	}
	searchURL := fmt.Sprintf("%s/search/multi?api_key=%s&language=%s&include_image_language=%s,null,en&query=%s",
		apiBase,
		url.QueryEscape(tmdb.APIKey),
		url.QueryEscape(req.Language),
		url.QueryEscape(req.Language),
		url.QueryEscape(req.Query),
	)

	client := buildTMDBClient(tmdb.ProxyURL)
	resp, err := client.Get(searchURL)
	if err != nil {
		log.TLogln("TMDB: request failed:", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("TMDB request failed: %v", err)})
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Failed to read TMDB response"})
		return
	}

	if resp.StatusCode != http.StatusOK {
		log.TLogln("TMDB: API returned status", resp.StatusCode, string(body))
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("TMDB API error: %d", resp.StatusCode)})
		return
	}

	var apiResp tmdbAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Failed to parse TMDB response"})
		return
	}

	// Pick image base URL based on language
	imgBase := strings.TrimRight(tmdb.ImageURL, "/")
	if req.Language == "ru" && tmdb.ImageURLRu != "" {
		imgBase = strings.TrimRight(tmdb.ImageURLRu, "/")
	}

	var results []tmdbSearchResult
	for _, r := range apiResp.Results {
		if r.PosterPath != "" {
			results = append(results, tmdbSearchResult{
				PosterURL: imgBase + "/t/p/w300" + r.PosterPath,
				MediaType: r.MediaType,
			})
		}
	}

	if results == nil {
		results = []tmdbSearchResult{}
	}
	c.JSON(http.StatusOK, results)
}

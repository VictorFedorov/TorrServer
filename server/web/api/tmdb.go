package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

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

type tmdbAPIResult struct {
	PosterPath string `json:"poster_path"`
}

type tmdbAPIResponse struct {
	Results []tmdbAPIResult `json:"results"`
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
//	@Success		200		{array}		string				"Poster URLs"
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
		c.JSON(http.StatusOK, []string{})
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

	resp, err := http.Get(searchURL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "TMDB request failed"})
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Failed to read TMDB response"})
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

	var posters []string
	for _, r := range apiResp.Results {
		if r.PosterPath != "" {
			posters = append(posters, imgBase+"/t/p/w300"+r.PosterPath)
		}
	}

	if posters == nil {
		posters = []string{}
	}
	c.JSON(http.StatusOK, posters)
}

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// uploadStream POSTs a file's bytes to /devices/file as one raw request.
// The one-time transfer token authorizes exactly this direction+path pair
// on the daemon side; the bearer token still rides along like every route.
func (n *Node) uploadStream(
	ctx context.Context,
	token string,
	body io.Reader,
	size int64,
) (int64, error) {
	q := url.Values{"transfer": {token}}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, n.apiURL("/devices/file", q), body,
	)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = size
	res, err := n.client.Do(n.authed(req))
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	reply, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf(
			"upload rejected (HTTP %d): %s",
			res.StatusCode, strings.TrimSpace(string(reply)),
		)
	}
	return size, nil
}

// downloadStream GETs a transfer token's bytes from /devices/file and
// copies them into dst, returning the byte count.
func (n *Node) downloadStream(
	ctx context.Context,
	token string,
	dst io.Writer,
) (int64, error) {
	q := url.Values{"transfer": {token}}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, n.apiURL("/devices/file", q), nil,
	)
	if err != nil {
		return 0, err
	}
	res, err := n.client.Do(n.authed(req))
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return 0, fmt.Errorf(
			"download rejected (HTTP %d): %s",
			res.StatusCode, strings.TrimSpace(string(body)),
		)
	}
	return io.Copy(dst, res.Body)
}

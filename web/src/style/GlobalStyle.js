import { createGlobalStyle, css } from 'styled-components'

import { standaloneMedia } from './standaloneMedia'

export default createGlobalStyle`
  *,
  *::before,
  *::after {
    margin: 0;
    padding: 0;
    box-sizing: inherit;
  }

  /* Reserve space for the vertical scrollbar even when it is not shown.
     Prevents viewport-width jitter when a fluid-sized element (the video
     player dialog) toggles the scrollbar on and off, which otherwise
     drives the player into a resize loop. */
  html {
    scrollbar-gutter: stable;
  }

  body {
    font-family: "Open Sans", sans-serif;
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.1px;
    -webkit-tap-highlight-color: transparent;


    ${standaloneMedia(css`
      height: 100vh;
    `)}
  }

  button {
    font-family: "Open Sans", sans-serif;
    letter-spacing: -0.1px;
  }
`

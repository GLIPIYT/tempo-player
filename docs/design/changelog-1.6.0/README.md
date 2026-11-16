# Tempo 1.6.0 visual changelog

The [poster composition](poster.html) uses figures in `figures/`. The full-size [release poster](tempo-1.6.0-changelog.webp) is 1280 pixels wide. Release notes display the [720-pixel preview](tempo-1.6.0-changelog-preview.webp) and link to the original.

The figures are isolated renders of production Tempo screens. The UI uses the display data and artwork already published with 1.5.0. Settings values, the example playlist report, network replies and waveform peaks are staged for the illustration. The lyrics scene shows a complete original demo text with example timings. The fixture runs without audio and without access to a real library or sign-in session.

To render a screen, start Vite and open `frames.html?frame=hero|home|light|visualizer|playlist|stats|playback|track|lyrics-view|network`. Let navigation transitions settle and clear programmatic focus before exporting. For the statistics, track settings and network figures, capture the respective dialog or menu element. Open `poster.html` at a viewport width of 1280 pixels to export the composition.

# Third-party software in UGCMediaClips

UGCMediaClips includes the following open-source software. Each is used unmodified.

## In-browser caption preview: JASSUB 2.5.21

The caption preview draws subtitles in your browser with JASSUB, a WebAssembly build of libass and the libraries below. The WebAssembly files (`jassub-worker.wasm`, `jassub-worker-modern.wasm`) are served as separate, unmodified files, so they can be replaced with any compatible build.

- **JASSUB**: MIT License. Copyright (c) 2021-2022 JASSUB contributors; Copyright (c) 2017-2021 JavascriptSubtitlesOctopus contributors. Full text below.
- **libass**: ISC License. Copyright (C) 2006-2016 libass contributors.
  Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
- **FreeType**: used under the FreeType License (FTL). Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.
- **HarfBuzz**: "Old MIT" License. Copyright © the HarfBuzz authors. Permission is hereby granted, without written agreement and without license or royalty fees, to use, copy, modify, and distribute this software and its documentation for any purpose, provided that the above copyright notice and the above two paragraphs appear in all copies of this software.
- **GNU FriBidi**: GNU Lesser General Public License, version 2.1 or later. Full text below.
- **Other components** compiled into the JASSUB build (e.g. its font and Unicode helpers) are under permissive licenses (MIT, ISC, Zlib, BSL-1.0, NTP); see the source below.

**Source code.** The exact source and build recipe for this build is JASSUB 2.5.21: https://github.com/ThaUnknown/jassub/tree/v2.5.21 (the npm package `jassub@2.5.21`). It builds libass, FreeType, HarfBuzz and FriBidi from their upstream sources. For three years from when we serve it, we will also send a copy of the corresponding source of the LGPL-licensed parts on request, for no more than the cost of sending it. Ask through the contact address in the Terms.

## Video editor: OpenReel

The optional timeline editor at `/editor/` is OpenReel; see its notice there.

## Caption fonts

The bundled caption fonts (Poppins, Anton, Bebas Neue, Archivo Black) are under the SIL Open Font License 1.1; the license files are served with the fonts at `/fonts/`.

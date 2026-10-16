# Editor

The clip editor at `/editor/` is [OpenReel](https://github.com/Augani/openreel-video) by Augustus Otu and contributors (MIT License), built from the commit in `OPENREEL_COMMIT` with small patches:

- `apply.mjs`:
  - serves the editor under `/editor/`;
  - turns off its service worker;
  - skips the recovery prompt when the editor is opened from UGCMediaClips;
  - loads the bridge.
- `bridge/clip-operator-bridge.tsx`:
  - loads a clip's shots, voiceover, captions, hook and call to action into a new project;
  - points the AI editor at UGCMediaClips's AI proxy;
  - adds **Save to UGCMediaClips**.

`build.sh` fetches the pinned commit, applies the patches and builds into `../editor-dist` (the Dockerfile runs it). To update OpenReel, change `OPENREEL_COMMIT`, run `bash editor/build.sh`, and fix any anchor `apply.mjs` reports as missing.

OpenReel's license:

```
MIT License

Copyright (c) 2024-2026 Augustus Otu and Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

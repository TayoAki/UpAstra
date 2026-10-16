# Hypit study

A line-by-line read of [hypit-ai/hypit](https://github.com/hypit-ai/hypit) (commit studied: see each batch), used under our commercial license from Hypit.AI, to plan a better UGCMediaClips. Notes describe and cite the original (`packages/<pkg>/src/<file>.ts:<line>`). They don't reproduce it wholesale.

Each batch is read in full, then checked by an independent reviewer who re-opens every cited line. Checked notes carry `Verified ✅`, and corrected ones are marked inline.

| # | Batch | Packages | Notes | Checked |
|---|---|---|---|---|
| 01 | Language & compiler | markup, loader, compiler, kernel, protocol, result, admission, facet, source, project, blob, atomic-file, workspace | [01-language-compiler.md](01-language-compiler.md) | Verified ✅ |
| 02 | Runtime & execution | runtime, runtime-local, executor, run, endpoint, credential-store-local, credential-store-env, producer | [02-runtime-execution.md](02-runtime-execution.md) | pending |
| 03 | CLI & companion | cli, studio-companion | [03-cli.md](03-cli.md) | Verified ✅ |
| 04 | Studio (preview app) | studio | [04-studio.md](04-studio.md) | Verified with corrections ⚠️ |
| 05 | Rendering | html-program, html-document, html-video, provider-html-local, browser-capture, visual-track, composition, film, video | [05-rendering.md](05-rendering.md) | Verified ✅ |
| 06 | Text & captions | caption, caption-fine, text, text-fine, fontsource, narrative-caption | [06-text-captions.md](06-text-captions.md) | Verified ✅ |
| 07 | Speech, alignment & time | whisperx, provider-whisperx-local, narrative-speech-alignment, speech-estimate, speech-evidence, narrative, narrative-temporal, temporal, timeline, timeline-author, script, author | [07-speech-time.md](07-speech-time.md) | pending |
| 08 | Overlay components | ranking, comment-sticker, interview-emoji-reveal, depth-stack, spatial, region-evidence | [08-overlays.md](08-overlays.md) | pending |
| 09 | Media & audio operations | media, media-local, media-operations, image-operations, provider-image-opencv-local, audio-track, volcengine-matting, yt-dlp, recipe | [09-media-ops.md](09-media-ops.md) | Verified with corrections ⚠️ |
| 10 | Generation providers | generation, provider-hypihub, provider-tokendance, provider-monid, provider-hiapi, provider-beatapi, provider-pollo, seedance, seedance-kits, gpt-image, gpt-image-kits, pixverse, grok-imagine, wan, nano-banana, seedream, minimax-h3, mimo-speech, fishaudio-speech, elevenlabs-speech | [10-generation.md](10-generation.md) | pending |
| 11 | Agent skill & playbooks | skills/hypit (references: creation, environment, playbooks, production) | [11-skill-playbooks.md](11-skill-playbooks.md) | Verified ✅ |

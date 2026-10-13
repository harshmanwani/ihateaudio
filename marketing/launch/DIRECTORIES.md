# Directories and listings tracker

Where ihateaudio is listed, where it is pending, and what each site wants in return.
Research done 13 Oct 2026 (live pages checked; "nv" = not verified). Copy for every form
is in `LAUNCH-KIT.md`. Identity on forms: Harsh Manwani, support@ihateaudio.com.

When a listing goes live and needs a badge: add it to `src/data/badges.ts`, add the
image host to `img-src` in `public/_headers`, run `npm run deploy`. The strip renders
on the homepage only, grey and dim (the SuperMailOS method).

Status: `todo` → `submitted` → `live` | `rejected` | `blocked (reason)` | `skip`

## Launch sites and directories (free)

| Site | Submit | Badge needed | Link | Status | Notes |
|---|---|---|---|---|---|
| Product Hunt | producthunt.com/posts/new | no | ugc | draft ready | Not scheduled (owner's call). Add the YouTube video when uploaded |
| AlternativeTo | alternativeto.net → Suggest new application | no | dofollow | blocked (account) | Add as alternative to 123apps, vocalremover.org, Audacity, media.io, TwistedWave |
| Uneed | uneed.best/submit-a-tool | no | dofollow at score ≥20 | blocked (account) | Needs sign-up before it saves. Owner signs in, then I submit |
| SaaSHub | saashub.com/services/submit | no | nofollow | blocked (account) | "You need to register to submit". Name competitors when submitting |
| Startup Fame | startupfa.me → Submit (goes to /login) | homepage, bot-checked | dofollow | blocked (account) | Review starts once the badge is live |
| Twelve Tools | twelve.tools/submit-your-tool | homepage link | dofollow | **live 13 Oct** | https://twelve.tools/ihateaudio · badge verified · category Audio |
| ScrollLaunch | scrolllaunch.com → New Launch | badge, re-checked weekly | dofollow | blocked (account) | Google or email magic link. Verifier greps homepage HTML for its image URL |
| LaunchPact | launchpact.io/startups | homepage badge → launchpact.io/startups | dofollow | blocked (account) | Directory only; avoid the "upvote pact" product (PH rules) |
| Bharat Hunt | bharathunt.org/submit | no | followed | blocked (bot check) | Vercel Security Checkpoint stops automation. Do by hand |
| Peerlist Launchpad | peerlist.io/launchpad | no | ugc | blocked (account) | Weekly; opens Monday 00:00 UTC. Owner's profile: @harshmanwani |
| Turbo0 | turbo0.com/submit | backlink required | 3 dofollow | todo | |
| Findly.tools | findly.tools/submit | badge, removed if it fails | dofollow | todo | Selective |
| Fazier | fazier.com/submit | homepage or footer link | nv | blocked (account) | Listed within 30 days |
| TinyLaunch | tinylaunch.com → Submit | top 3 only | dofollow top 3 | todo | ~4 week queue; "Music & Audio" category |
| OpenLaunch | openlaunch.ai/projects/submit | nv | dofollow top 3 | todo | 5 free slots a day |
| Indie Hackers | indiehackers.com/products | no | nofollow | todo | |
| Dang.ai | dang.ai/submit | backlink to dang.ai | nv | todo | AI tools only → list the AI studio |
| StartupBase | startupbase.io/launch | badge | nv | todo | ~4–5 week queue |
| Launching Next | launchingnext.com/submit/ | no | nv | filled, owner to submit | Form filled 13 Oct; the "What is 2+3?" bot check and Submit are for a human |
| Bedroom Producers Blog | bedroomproducersblog.com/contact/ | no | nv | todo | A pitch, not a form listing: needs the owner's approval to send |
| KVR Audio | kvraudio.com/submissions.php | no | nv | todo | Cloudflare check; do by hand |
| Crunchbase | crunchbase.com | no | nv | todo | Needs a social-auth account |

Skipped on purpose: LaunchBuff (nofollow, 1-year queue), Microlaunch (no free path),
Tiny Startups (nofollow), SideProjectors (marketplace), DevHunt (dev tools only),
BetaList, There's An AI For That, Futurepedia, Toolify (all paid), awesome-privacy
(needs open source).

## MCP and AI listings

| Place | Method | Status | Notes |
|---|---|---|---|
| Official MCP Registry | `mcp-publisher publish` (HTTP domain auth) | **live 13 Oct** | `com.ihateaudio/ihateaudio` v0.3.0 (latest). Key: `~/Desktop/certs/ihateaudio-mcp-registry-ed25519.pem`. The login token expires; run `mcp-publisher login http` again before each publish |
| Glama connectors | auto-copied from the registry; claim with `/.well-known/glama.json` | todo | Claim needs a Glama login |
| awesome-remote-mcp-servers | GitHub PR | todo | Needs the Glama badge first |
| Smithery | smithery.ai/new | todo | |
| Docker MCP Catalog | PR to docker/mcp-registry (`type: remote`) | todo | |
| mcpservers.org | web form | todo | Free tier is nofollow |
| Claude Connectors Directory | claude.ai/directory/manage | ready, needs login | Copy in `MCP-LISTINGS.md`. Needs a paid Claude plan |
| OpenAI plugin directory | platform.openai.com/plugins | ready, needs login | Copy and test cases in `MCP-LISTINGS.md`. Needs org verification and a ChatGPT demo recording |
| PulseMCP | closed to submissions | skip | Picks up registry entries when it reopens |

### MCP server fixes (done 13 Oct, server 0.3.0)

1. `file_id` is optional; any public HTTPS `download_url` works. Links without a
   Content-Length are read in with the 250 MB cap.
2. Every result has a text block with each download link and its expiry, as well as
   the resource links.
3. The three "send audio" tools say they only prepare files and send nothing.
4. `voice_recorder` is gone from the MCP server (website only).
5. Every description says where the file goes, how long links last, and frames the AI
   tools as separation and recognition. /privacy, /terms and /support now cover every
   MCP client, the 1-hour links and the request logs.
6. Added: a retry when Cloudflare refuses a new browser (429), and a User-Agent on the
   download request (Wikimedia refuses requests without one).

Verified live: `loudness_meter` and `audio_trimmer` with a plain Wikimedia link and no
`file_id`; the trimmed MP3 is 2.53 s as asked.

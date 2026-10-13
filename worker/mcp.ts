import { launch } from '@cloudflare/playwright';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';

// The page.evaluate callbacks below run inside the remote page, where `document` exists.
declare const document: any;

export interface McpEnv {
  BROWSER: Parameters<typeof launch>[0];
  MODELS: R2Bucket;
}

const ORIGIN='https://ihateaudio.com', INPUT='mcp-input/', OUTPUT='mcp-output/', TTL=3600_000, MAX=250*1024*1024;
// ChatGPT fills `file_id` in by itself; every other MCP client only has a link to give,
// so the link is the one thing an input must carry.
const FILE=z.object({
  download_url:z.string().url().describe('Public HTTPS link to the audio or video file. The server downloads it from here.'),
  file_id:z.string().min(1).optional().describe('Set by ChatGPT for files shared in the chat. Other clients leave it out.'),
  mime_type:z.string().optional(),file_name:z.string().optional(),
}).strict();
const FILES=z.array(FILE).min(1).max(12);
const MULTI=new Set(['audio-joiner','crossfade-joiner']);
const ANALYSIS=new Set(['bpm-detector','key-finder','loudness-meter']);
const ACTIONS:Record<string,{name:string;params:string}>={
'8d-audio-maker':{name:'set_8d_effect',params:'secondsPerTurn, distance'},'android-ringtone-maker':{name:'set_ringtone',params:'startSec, endSec, fadeOut, fadeSec'},'audio-compressor':{name:'set_compression',params:'bitrateKbps, sampleRateHz, channels'},'audio-joiner':{name:'set_join_gap',params:'gapSec'},'audio-looper':{name:'set_loop',params:'repeats, gapSec'},'audio-normalizer':{name:'set_loudness_target',params:'platform, targetLufs, ceilingDbtp'},'audio-splitter':{name:'set_split',params:'method, parts, partLengthSec, silenceThresholdDbfs, minimumGapSec'},'audio-transcriber':{name:'set_transcript_layout',params:'paragraphs'},'audio-trimmer':{name:'set_trim',params:'startSec, endSec, mode, fade'},'bass-booster':{name:'set_bass_boost',params:'amountDb, cornerHz, keepLevel'},'bpm-detector':{name:'set_analysis_range',params:'selectionOnly'},'crossfade-joiner':{name:'set_crossfade',params:'fadeSec'},'dynamic-compressor':{name:'set_compressor',params:'preset, thresholdDb, ratio, attackMs, releaseMs, kneeDb, makeupDb'},'echo-adder':{name:'set_echo',params:'preset, delayMs, feedbackPercent, mixPercent'},'equalizer':{name:'set_equalizer',params:'preset'},'fade-in-out':{name:'set_fade',params:'fadeInSec, fadeOutSec, curve'},'nightcore-maker':{name:'set_nightcore',params:'rate, preset'},'noise-remover':{name:'set_noise_reduction',params:'strength'},'pitch-shifter':{name:'set_pitch_shift',params:'semitones, cents'},'reverb-adder':{name:'set_reverb',params:'space, decaySec, mix, preDelayMs'},'ringtone-maker':{name:'set_ringtone',params:'startSec, endSec, fadeOut, fadeSec'},'sample-rate-converter':{name:'set_sample_rate',params:'sampleRateHz'},'silence-remover':{name:'set_silence_removal',params:'threshold, minimumGapSec, paddingSec'},'slowed-reverb':{name:'set_slowed_reverb',params:'intensity, speed, mix, decaySec'},'speed-changer':{name:'set_speed',params:'speed, keepPitch'},'stem-splitter':{name:'set_stems',params:'vocals, drums, bass, other'},'stereo-to-mono':{name:'set_channel_mode',params:'mode'},'stereo-widener':{name:'set_stereo_width',params:'width'},'tempo-changer':{name:'set_tempo',params:'tempoPercent, bpm'},'voice-changer':{name:'set_voice',params:'preset, semitones'},'volume-booster':{name:'set_volume',params:'method, gainDb, targetPeakDbfs'},'wav-converter':{name:'set_wav_bit_depth',params:'bitDepth'},'waveform-generator':{name:'set_waveform_image',params:'preset, widthPx, heightPx, style, waveColor, backgroundColor, transparent'}
};
// What each tool does, in plain terms, for the model choosing a tool. Kept factual on
// purpose: directory reviewers reject descriptions that sell, and the AI tools are
// separation and recognition, not generation. The voice recorder is not here at all,
// because a remote worker cannot open anyone's microphone.
const SUMMARY:Record<string,string>={
'audio-trimmer':'Cuts an audio file down to a start and end time, or removes that section.',
'audio-joiner':'Joins several audio files into one, in the order given, with an optional gap.',
'audio-splitter':'Splits a recording into parts: a set number, a set length, or at silences.',
'silence-remover':'Shortens long silences in speech recordings.',
'fade-in-out':'Adds a fade-in at the start and a fade-out at the end.',
'audio-reverser':'Reverses audio so it plays from end to start.',
'audio-looper':'Repeats a clip a set number of times, with an optional gap.',
'crossfade-joiner':'Joins several files with a crossfade between each pair.',
'audio-converter':'Converts audio between MP3, WAV, M4A, OGG, FLAC and other formats.',
'mp3-converter':'Converts an audio or video file to MP3.',
'wav-converter':'Converts audio to WAV at 16, 24 or 32-bit.',
'm4a-converter':'Converts audio to M4A (AAC).',
'ogg-converter':'Converts audio to OGG Vorbis.',
'flac-converter':'Converts audio to lossless FLAC.',
'video-to-audio':'Extracts the audio track from a video file such as MP4, MOV or MKV.',
'audio-compressor':'Makes an audio file smaller by lowering its bitrate, sample rate or channel count.',
'sample-rate-converter':'Resamples audio to a different sample rate.',
'send-audio-on-whatsapp':"Prepares audio to fit WhatsApp's 16 MB limit by recompressing it or splitting it at pauses. It returns the files and does not send anything to WhatsApp.",
'send-audio-on-discord':"Prepares audio to fit Discord's upload limit by recompressing it or splitting it. It returns the files and does not send anything to Discord.",
'send-audio-by-email':'Prepares audio to fit common email attachment limits by recompressing it or splitting it. It returns the files and does not send any email.',
'volume-booster':'Raises the volume by a gain in dB or up to a target peak.',
'audio-normalizer':'Normalizes loudness to a LUFS target, such as -14 for Spotify or -16 for podcasts, with a true-peak ceiling.',
'bass-booster':'Boosts the low frequencies.',
'dynamic-compressor':'Applies dynamic range compression to even out levels.',
'stereo-to-mono':'Converts between stereo and mono, or keeps one channel.',
'speed-changer':'Changes playback speed, with or without changing pitch.',
'pitch-shifter':'Shifts pitch by semitones and cents without changing length.',
'tempo-changer':'Changes tempo without changing pitch.',
'slowed-reverb':'Slows a track down and adds reverb (the "slowed + reverb" edit).',
'nightcore-maker':'Speeds a track up and raises its pitch (the "nightcore" edit).',
'voice-changer':'Applies a voice effect preset or a pitch shift to a recorded voice.',
'reverb-adder':'Adds convolution reverb.',
'echo-adder':'Adds an echo or delay effect.',
'8d-audio-maker':'Pans the audio in a circle around the listener (the "8D audio" effect).',
'equalizer':'Applies an equalizer preset.',
'stereo-widener':'Widens or narrows the stereo image.',
'ringtone-maker':'Cuts a section of a song into an M4R ringtone for iPhone.',
'android-ringtone-maker':'Cuts a section of a song into an MP3 ringtone for Android.',
'bpm-detector':'Measures the tempo of a track in BPM.',
'key-finder':'Detects the musical key of a track and its Camelot code.',
'loudness-meter':'Measures integrated loudness (LUFS), loudness range and true peak to ITU-R BS.1770.',
'waveform-generator':'Draws a PNG image of the waveform.',
'vocal-remover':'Removes the vocals from a song by source separation and returns the instrumental.',
'acapella-extractor':'Isolates the vocals from a song by source separation and returns the vocal track.',
'stem-splitter':'Separates a song into stems (vocals, drums, bass, other) by source separation.',
'audio-transcriber':'Transcribes the speech in a recording to text with the Whisper speech recognition model.',
'subtitle-generator':'Transcribes speech and returns an SRT or VTT subtitle file.',
'noise-remover':'Reduces background noise such as hiss, hum and room noise in a recording.',
};
const SLUGS=Object.keys(SUMMARY);
// Said on every tool, because a reviewer and a user both need to know where the file goes.
const HANDLING='The server downloads the file from download_url, keeps it in ihateaudio\'s Cloudflare R2 storage while the job runs, and processes it with the ihateaudio.com tool page in a headless browser on Cloudflare. The input is deleted when the job ends.';

const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const slugName=(s:string)=>s.replace(/-/g,'_');
const title=(s:string)=>s.split('-').map(p=>['8d','mp3','wav','m4a','ogg','flac','bpm'].includes(p)?p.toUpperCase():p[0]?.toUpperCase()+p.slice(1)).join(' ');
const mime=(n:string)=>({mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',opus:'audio/ogg',flac:'audio/flac',m4r:'audio/mp4',webm:'audio/webm',png:'image/png',srt:'application/x-subrip',vtt:'text/vtt',txt:'text/plain'}[n.toLowerCase().split('.').pop()||'']||'application/octet-stream');
// Without a file_name, the last part of the link is the best name there is, and its
// extension is what the page reads the format from.
const lastSegment=(u:URL)=>{const raw=u.pathname.split('/').pop()||'';try{return decodeURIComponent(raw)}catch{return raw}};
const fileName=(f:z.infer<typeof FILE>,u:URL)=>(f.file_name?.trim()||lastSegment(u)||'audio').replace(/[\r\n]/g,'_').slice(0,180);

async function readCapped(stream:ReadableStream<Uint8Array>){
  const parts:Uint8Array[]=[], reader=stream.getReader(); let size=0;
  for(;;){const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>MAX){await reader.cancel(); throw new Error('The file is larger than the 250 MB limit.')} parts.push(value)}
  const out=new Uint8Array(size); let at=0; for(const p of parts){out.set(p,at); at+=p.byteLength}
  return out;
}
async function stage(env:McpEnv,f:z.infer<typeof FILE>){
  const u=new URL(f.download_url); if(u.protocol!=='https:') throw new Error('The supplied file URL must use HTTPS.');
  // Hosts such as Wikimedia refuse requests that do not say who is asking.
  const r=await fetch(u,{headers:{'user-agent':'ihateaudio-mcp/0.3 (+https://ihateaudio.com/support)'}}); if(!r.ok||!r.body) throw new Error('Could not download the file from download_url (HTTP '+r.status+').');
  const len=Number(r.headers.get('content-length')||0); if(len>MAX) throw new Error('The file is larger than the 250 MB limit.');
  const id=crypto.randomUUID().replace(/-/g,''); const key=INPUT+id, name=fileName(f,u), mt=f.mime_type||r.headers.get('content-type')||'application/octet-stream';
  // R2 can stream a body straight in only when its length is known. ChatGPT's links
  // always say; an arbitrary link may not, so that body is read in first, capped.
  const body=len>0?r.body:await readCapped(r.body);
  await env.MODELS.put(key,body,{httpMetadata:{contentType:mt},customMetadata:{expiresAt:String(Date.now()+TTL)}});
  return {key,url:ORIGIN+'/mcp-files/input/'+id+'/'+encodeURIComponent(name),name,mime:mt};
}

// Downloads never reach the Worker: Browser Rendering's browser runs on another
// machine, so Playwright's download stream comes back empty. Every save on the
// site goes through saveBlob (an object URL on a clicked <a download>), so the
// bridge keeps those blobs in the page instead and they are read back from there.
const CHUNK=512*1024;
const savedCount=(page:any):Promise<number>=>page.evaluate(()=>(globalThis as any).__ihaSaved.length);
async function readSaved(page:any,i:number):Promise<{name:string;body:Uint8Array}>{
  const {name,size}=await page.evaluate((i:number)=>{const x=(globalThis as any).__ihaSaved[i];return {name:String(x.name),size:x.blob.size as number}},i);
  if(!size) throw new Error('The browser returned an empty download.');
  if(size>MAX) throw new Error('The result is larger than the 250 MB plugin limit.');
  const body=new Uint8Array(size);
  for(let at=0;at<size;at+=CHUNK){
    const b64:string=await page.evaluate(({i,at,end}:{i:number;at:number;end:number})=>new Promise((ok,fail)=>{const r=new (globalThis as any).FileReader();r.onload=()=>ok(String(r.result).slice(String(r.result).indexOf(',')+1));r.onerror=()=>fail(r.error);r.readAsDataURL((globalThis as any).__ihaSaved[i].blob.slice(at,end))}),{i,at,end:Math.min(size,at+CHUNK)});
    const bin=atob(b64); for(let k=0;k<bin.length;k++) body[at+k]=bin.charCodeAt(k);
  }
  return {name,body};
}
async function saveOutput(env:McpEnv,file:{name:string;body:Uint8Array}){
  const name=(file.name||'ihateaudio-output').replace(/[\r\n]/g,'_').slice(0,180), id=crypto.randomUUID().replace(/-/g,'');
  const mt=mime(name), key=OUTPUT+id;
  const expiresAt=Date.now()+TTL;
  await env.MODELS.put(key,file.body,{httpMetadata:{contentType:mt,contentDisposition:'attachment; filename="'+name.replace(/"/g,'_')+'"',cacheControl:'private, max-age=60'},customMetadata:{expiresAt:String(expiresAt),fileName:name}});
  return {name,mime:mt,url:ORIGIN+'/mcp-files/output/'+id+'/'+encodeURIComponent(name),expiresAt:new Date(expiresAt).toISOString()};
}
/** Waits until the page has saved more than `from` files, then stores every new one. */
async function collect(page:any,env:McpEnv,from:number,waitMs:number){
  for(let t=0;t<waitMs&&(await savedCount(page))<=from;t+=250) await sleep(250);
  const n=await savedCount(page), out:any[]=[];
  for(let i=from;i<n;i++) out.push(await saveOutput(env,await readSaved(page,i)));
  return out;
}

async function bridge(page:any){await page.addInitScript(()=>{
  const reg:any[]=[]; const host={registerTool:(t:any)=>reg.push(t)};
  Object.defineProperty(globalThis,'__ihaAgentTools',{configurable:true,value:reg});
  const saved:any[]=[], blobs=new Map<string,Blob>(), make=URL.createObjectURL, A=(globalThis as any).HTMLAnchorElement.prototype, click=A.click;
  Object.defineProperty(globalThis,'__ihaSaved',{configurable:true,value:saved});
  URL.createObjectURL=function(o:any){const u=make.call(URL,o);if(o instanceof Blob)blobs.set(u,o);return u};
  A.click=function(this:any){const b=this.download&&blobs.get(this.href);if(b){saved.push({name:this.download,blob:b});return}return click.call(this)};
  try{Object.defineProperty(document,'modelContext',{configurable:true,value:host})}catch{try{(document as any).modelContext=host}catch{}}
  try{Object.defineProperty(navigator,'modelContext',{configurable:true,value:host})}catch{try{(navigator as any).modelContext=host}catch{}}
})}
async function siteTool(page:any,name:string,input:any={}){return page.evaluate(async({name,input}:{name:string;input:any})=>{const ts=(globalThis as any).__ihaAgentTools||[],t=ts.find((x:any)=>x?.name===name);if(!t)throw new Error('iHateAudio page tool not found: '+name);return t.execute(input)},{name,input})}
async function waitTools(page:any){for(let i=0;i<100;i++){if(await page.evaluate(()=>Array.isArray((globalThis as any).__ihaAgentTools)&&((globalThis as any).__ihaAgentTools||[]).some((t:any)=>t?.name==='inspect_audio')))return;await sleep(200)}throw new Error('iHateAudio did not expose its WebMCP tools.')}
async function waitLoaded(page:any){for(let i=0;i<360;i++){const x=await page.evaluate(()=>{const w=document.querySelector('[data-workspace]'),d=document.querySelector('[data-drop]');return !!(w&&!w.hasAttribute('hidden'))||!!(d?.hasAttribute('hidden'))});if(x)return;await sleep(250)}throw new Error('The audio file did not finish loading.')}
async function analysis(page:any,slug:string){for(let i=0;i<360;i++){const x=await page.evaluate((s:string)=>{const t=(q:string)=>document.querySelector(q)?.textContent?.trim()||null;if(s==='bpm-detector'){const bpm=t('[data-bpm]');return {ready:!!bpm&&bpm!=='···',bpm,confidence:t('[data-confidence]'),explanation:t('[data-confidence-text]'),halfTime:t('[data-reading="half"]'),main:t('[data-reading="main"]'),doubleTime:t('[data-reading="double"]')}}if(s==='key-finder'){const k=t('[data-key-name]');return {ready:!!k,key:k,camelot:t('[data-key-camelot]'),confidence:t('[data-key-confidence]'),secondChoice:t('[data-key-second]')}}const i=t('[data-stat="integrated"]');return {ready:!!i&&i!=='···',integrated:i,range:t('[data-stat="range"]'),truePeak:t('[data-stat="truepeak"]'),peak:t('[data-stat="peak"]')};},slug);if((x as any).ready)return x;await sleep(250)}throw new Error(title(slug)+' analysis timed out.')}
async function exportPage(page:any,env:McpEnv,format?:string){const before=await savedCount(page);await siteTool(page,'export_download',format?{format}:{});const buttons=page.locator('[data-results] .result button'),n=await buttons.count();for(let i=0;i<n;i++)await buttons.nth(i).click();const out=await collect(page,env,before,1500);if(!out.length)throw new Error('iHateAudio finished without producing a downloadable file.');return out}
async function waveform(page:any,env:McpEnv){const b=page.locator('[data-png-download]');await b.waitFor({state:'visible',timeout:20_000});const before=await savedCount(page);await b.click();const out=await collect(page,env,before,20_000);if(!out.length)throw new Error('The waveform image was not produced.');return out}

// Browser Rendering caps how many browsers an account may start per minute, so a
// second job inside that window gets a 429. Waiting it out beats failing a job that
// would have worked 20 seconds later; the last word is a message a person can act on.
async function openBrowser(env:McpEnv){
  for(let attempt=1;;attempt++){
    try{return await launch(env.BROWSER)}
    catch(e){
      if(!/429|rate limit/i.test(String(e)))throw e;
      if(attempt>=6)throw new Error('iHateAudio is busy right now. Try again in a minute.');
      await sleep(4000*attempt);
    }
  }
}

async function run(env:McpEnv,slug:string,files:z.infer<typeof FILE>[],settings:any,outputFormat?:string,bitrateKbps?:number){
  if(!MULTI.has(slug)&&files.length!==1)throw new Error(title(slug)+' accepts one input file.');
  const browser=await openBrowser(env),page=await browser.newPage(); page.setDefaultTimeout(120_000); const keys:string[]=[];
  try{await bridge(page);await page.goto(ORIGIN+'/'+slug,{waitUntil:'domcontentloaded',timeout:120_000});await waitTools(page);
    if(MULTI.has(slug)){const staged=await Promise.all(files.map(f=>stage(env,f)));keys.push(...staged.map(x=>x.key));const payloads=await Promise.all(staged.map(async x=>{const r=await fetch(x.url);if(!r.ok)throw new Error('Could not read staged input file.');return {name:x.name,mimeType:x.mime,buffer:new Uint8Array(await r.arrayBuffer())}}));await page.locator('[data-file-input]').setInputFiles(payloads as any);await waitLoaded(page)}
    else{const x=await stage(env,files[0]);keys.push(x.key);await siteTool(page,'load_audio_from_url',{url:x.url});await waitLoaded(page)}
    const a=ACTIONS[slug];if(a)await siteTool(page,a.name,settings||{});
    if(outputFormat||bitrateKbps!==undefined)await siteTool(page,'set_output_format',{...(outputFormat?{format:outputFormat}:{}),...(bitrateKbps!==undefined?{bitrateKbps}:{} )});
    if(ANALYSIS.has(slug))return await analysis(page,slug);
    if(slug==='waveform-generator')return await waveform(page,env);
    return await exportPage(page,env,outputFormat);
  }finally{await Promise.all(keys.map(k=>env.MODELS.delete(k)));await browser.close()}
}

function describe(slug:string){
  const a=ACTIONS[slug], out=[SUMMARY[slug]];
  out.push(MULTI.has(slug)?'Input: two or more files, in order, each with a public HTTPS download_url.':'Input: one file with a public HTTPS download_url.');
  if(a) out.push('Optional settings for '+a.name+': '+a.params+'.');
  if(ANALYSIS.has(slug)) out.push('Returns the measurements as JSON, not a file.');
  else{
    if(!WITHOUT_FORMAT.has(slug)) out.push('Optional outputFormat (for example mp3, wav, m4a) and bitrateKbps where the tool supports them.');
    out.push('Returns download links for the result, which expire after 1 hour.');
  }
  out.push(HANDLING);
  return out.join(' ');
}
const WITHOUT_FORMAT=new Set(['waveform-generator']);

/** The text block names every link and its expiry, for clients that do not show resource links. */
function resultContent(slug:string,files:{name:string;url:string;mime:string;expiresAt:string}[]){
  const lines=files.map(x=>'- '+x.name+': '+x.url);
  const text=(files.length===1?'iHateAudio finished '+title(slug)+'.':'iHateAudio finished '+title(slug)+' and produced '+files.length+' files.')+'\nDownload (links expire '+files[0].expiresAt+'):\n'+lines.join('\n');
  return {content:[{type:'text',text},...files.map(x=>({type:'resource_link',uri:x.url,name:x.name,mimeType:x.mime,description:'Processed output from iHateAudio. The link expires '+x.expiresAt+'.'}))]};
}

function register(server:McpServer,env:McpEnv){for(const slug of SLUGS){
  const a=ACTIONS[slug], shape:any={files:FILES.describe(MULTI.has(slug)?'Input files in processing order.':'One input media file.')};
  if(a)shape.settings=z.record(z.string(),z.unknown()).optional().describe('Parameters for '+a.name+': '+a.params+'.');
  if(!ANALYSIS.has(slug)&&!WITHOUT_FORMAT.has(slug)){shape.outputFormat=z.string().optional().describe('Output format, for example mp3, wav, m4a, ogg or flac.');shape.bitrateKbps=z.number().positive().optional().describe('Bitrate for lossy formats, in kbps.')}
  // readOnly: the analysis tools only measure. Nothing here deletes or changes data the
  // user already has, and nothing reaches past the given link and our own storage.
  server.registerTool(slugName(slug),{title:title(slug),description:describe(slug),inputSchema:shape,annotations:{readOnlyHint:ANALYSIS.has(slug),destructiveHint:false,idempotentHint:false,openWorldHint:false},_meta:{'openai/fileParams':['files']}},async(input:any):Promise<any>=>{
    try{const result=await run(env,slug,input.files,input.settings||{},input.outputFormat,input.bitrateKbps);
      if(Array.isArray(result)&&result[0]?.url)return resultContent(slug,result);
      return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(e){return {isError:true,content:[{type:'text',text:e instanceof Error?e.message:'iHateAudio processing failed.'}]}}
  });
}}

export function handleMcp(request:Request,env:McpEnv,ctx:ExecutionContext){return createMcpHandler(()=>{const s=new McpServer({name:'ihateaudio',version:'0.3.0'});register(s,env);return s},{route:'/mcp'})(request,env,ctx)}
export async function serveMcpFile(request:Request,env:McpEnv){const m=new URL(request.url).pathname.match(/^\/mcp-files\/(input|output)\/([^/]+)(?:\/.*)?$/);if(!m)return new Response('Not found',{status:404});const prefix=m[1]==='input'?INPUT:OUTPUT,obj=await env.MODELS.get(prefix+m[2]);if(!obj)return new Response('Not found',{status:404});const exp=Number(obj.customMetadata?.expiresAt||0);if(exp&&exp<Date.now()){await env.MODELS.delete(prefix+m[2]);return new Response('Expired',{status:410})}const h=new Headers();obj.writeHttpMetadata(h);h.set('etag',obj.httpEtag);h.set('access-control-allow-origin','*');h.set('x-content-type-options','nosniff');h.set('content-security-policy',"default-src 'none'; sandbox");if(m[1]==='input')h.set('content-disposition','attachment');return request.method==='HEAD'?new Response(null,{headers:h}):new Response(obj.body,{headers:h})}
async function clean(bucket:R2Bucket,prefix:string){let cursor:string|undefined;do{const x=await bucket.list({prefix,limit:1000,cursor});const now=Date.now();const dead=x.objects.filter(o=>Number(o.customMetadata?.expiresAt||0)>0&&Number(o.customMetadata?.expiresAt||0)<now);if(dead.length)await Promise.all(dead.map(o=>bucket.delete(o.key)));cursor=x.truncated?x.cursor:undefined}while(cursor)}
export const cleanupMcpFiles=(env:McpEnv)=>Promise.all([clean(env.MODELS,INPUT),clean(env.MODELS,OUTPUT)]);

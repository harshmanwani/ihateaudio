import { launch } from '@cloudflare/playwright';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { Readable } from 'node:stream';

export interface McpEnv {
  BROWSER: Parameters<typeof launch>[0];
  MODELS: R2Bucket;
}

const ORIGIN='https://ihateaudio.com', INPUT='mcp-input/', OUTPUT='mcp-output/', TTL=3600_000, MAX=250*1024*1024, TIMEOUT=10*60_000;
const FILE=z.object({download_url:z.string().url(),file_id:z.string().min(1),mime_type:z.string().optional(),file_name:z.string().optional()}).strict();
const FILES=z.array(FILE).min(1).max(12);
const MULTI=new Set(['audio-joiner','crossfade-joiner']);
const ANALYSIS=new Set(['bpm-detector','key-finder','loudness-meter']);
const ACTIONS:Record<string,{name:string;params:string}>={
'8d-audio-maker':{name:'set_8d_effect',params:'secondsPerTurn, distance'},'android-ringtone-maker':{name:'set_ringtone',params:'startSec, endSec, fadeOut, fadeSec'},'audio-compressor':{name:'set_compression',params:'bitrateKbps, sampleRateHz, channels'},'audio-joiner':{name:'set_join_gap',params:'gapSec'},'audio-looper':{name:'set_loop',params:'repeats, gapSec'},'audio-normalizer':{name:'set_loudness_target',params:'platform, targetLufs, ceilingDbtp'},'audio-splitter':{name:'set_split',params:'method, parts, partLengthSec, silenceThresholdDbfs, minimumGapSec'},'audio-transcriber':{name:'set_transcript_layout',params:'paragraphs'},'audio-trimmer':{name:'set_trim',params:'startSec, endSec, mode, fade'},'bass-booster':{name:'set_bass_boost',params:'amountDb, cornerHz, keepLevel'},'bpm-detector':{name:'set_analysis_range',params:'selectionOnly'},'crossfade-joiner':{name:'set_crossfade',params:'fadeSec'},'dynamic-compressor':{name:'set_compressor',params:'preset, thresholdDb, ratio, attackMs, releaseMs, kneeDb, makeupDb'},'echo-adder':{name:'set_echo',params:'preset, delayMs, feedbackPercent, mixPercent'},'equalizer':{name:'set_equalizer',params:'preset'},'fade-in-out':{name:'set_fade',params:'fadeInSec, fadeOutSec, curve'},'nightcore-maker':{name:'set_nightcore',params:'rate, preset'},'noise-remover':{name:'set_noise_reduction',params:'strength'},'pitch-shifter':{name:'set_pitch_shift',params:'semitones, cents'},'reverb-adder':{name:'set_reverb',params:'space, decaySec, mix, preDelayMs'},'ringtone-maker':{name:'set_ringtone',params:'startSec, endSec, fadeOut, fadeSec'},'sample-rate-converter':{name:'set_sample_rate',params:'sampleRateHz'},'silence-remover':{name:'set_silence_removal',params:'threshold, minimumGapSec, paddingSec'},'slowed-reverb':{name:'set_slowed_reverb',params:'intensity, speed, mix, decaySec'},'speed-changer':{name:'set_speed',params:'speed, keepPitch'},'stem-splitter':{name:'set_stems',params:'vocals, drums, bass, other'},'stereo-to-mono':{name:'set_channel_mode',params:'mode'},'stereo-widener':{name:'set_stereo_width',params:'width'},'tempo-changer':{name:'set_tempo',params:'tempoPercent, bpm'},'voice-changer':{name:'set_voice',params:'preset, semitones'},'volume-booster':{name:'set_volume',params:'method, gainDb, targetPeakDbfs'},'wav-converter':{name:'set_wav_bit_depth',params:'bitDepth'},'waveform-generator':{name:'set_waveform_image',params:'preset, widthPx, heightPx, style, waveColor, backgroundColor, transparent'}
};
const SLUGS=['audio-trimmer','audio-joiner','audio-splitter','silence-remover','fade-in-out','audio-reverser','audio-looper','crossfade-joiner','audio-converter','mp3-converter','wav-converter','m4a-converter','ogg-converter','flac-converter','video-to-audio','audio-compressor','sample-rate-converter','send-audio-on-whatsapp','send-audio-on-discord','send-audio-by-email','volume-booster','audio-normalizer','bass-booster','dynamic-compressor','stereo-to-mono','speed-changer','pitch-shifter','tempo-changer','slowed-reverb','nightcore-maker','voice-changer','reverb-adder','echo-adder','8d-audio-maker','equalizer','stereo-widener','ringtone-maker','android-ringtone-maker','voice-recorder','bpm-detector','key-finder','loudness-meter','waveform-generator','vocal-remover','acapella-extractor','stem-splitter','audio-transcriber','subtitle-generator','noise-remover'] as const;

const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const slugName=(s:string)=>s.replace(/-/g,'_');
const title=(s:string)=>s.split('-').map(p=>['8d','mp3','wav','m4a','ogg','flac','bpm'].includes(p)?p.toUpperCase():p[0]?.toUpperCase()+p.slice(1)).join(' ');
const mime=(n:string)=>({mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',opus:'audio/ogg',flac:'audio/flac',m4r:'audio/mp4',webm:'audio/webm',png:'image/png',srt:'application/x-subrip',vtt:'text/vtt',txt:'text/plain'}[n.toLowerCase().split('.').pop()||'']||'application/octet-stream');
const fileName=(f:z.infer<typeof FILE>)=>(f.file_name?.trim()||'audio').replace(/[\r\n]/g,'_').slice(0,180);

async function stage(env:McpEnv,f:z.infer<typeof FILE>){
  const u=new URL(f.download_url); if(u.protocol!=='https:') throw new Error('The supplied file URL must use HTTPS.');
  const r=await fetch(u); if(!r.ok||!r.body) throw new Error('Could not read the uploaded file.');
  const len=Number(r.headers.get('content-length')||0); if(len>MAX) throw new Error('The uploaded file is larger than the 250 MB plugin limit.');
  const id=crypto.randomUUID().replace(/-/g,''); const key=INPUT+id, name=fileName(f), mt=f.mime_type||r.headers.get('content-type')||'application/octet-stream';
  await env.MODELS.put(key,r.body,{httpMetadata:{contentType:mt},customMetadata:{expiresAt:String(Date.now()+TTL)}});
  return {key,url:ORIGIN+'/mcp-files/input/'+id+'/'+encodeURIComponent(name),name,mime:mt};
}

async function saveDownload(env:McpEnv,d:any){
  const name=String(d.suggestedFilename?.()||'ihateaudio-output').replace(/[\r\n]/g,'_').slice(0,180), id=crypto.randomUUID().replace(/-/g,'');
  let body:any=await d.createReadStream(); if(!body) throw new Error('The browser returned an empty download.');
  if(typeof body.pipe==='function') body=Readable.toWeb(body);
  const mt=mime(name), key=OUTPUT+id;
  await env.MODELS.put(key,body,{httpMetadata:{contentType:mt,contentDisposition:'attachment; filename="'+name.replace(/"/g,'_')+'"',cacheControl:'private, max-age=60'},customMetadata:{expiresAt:String(Date.now()+TTL),fileName:name}});
  return {name,mime:mt,url:ORIGIN+'/mcp-files/output/'+id+'/'+encodeURIComponent(name)};
}

async function bridge(page:any){await page.addInitScript(()=>{
  const reg:any[]=[]; const host={registerTool:(t:any)=>reg.push(t)};
  Object.defineProperty(globalThis,'__ihaAgentTools',{configurable:true,value:reg});
  try{Object.defineProperty(document,'modelContext',{configurable:true,value:host})}catch{try{(document as any).modelContext=host}catch{}}
  try{Object.defineProperty(navigator,'modelContext',{configurable:true,value:host})}catch{try{(navigator as any).modelContext=host}catch{}}
})}
async function siteTool(page:any,name:string,input:any={}){return page.evaluate(async({name,input})=>{const ts=(globalThis as any).__ihaAgentTools||[],t=ts.find((x:any)=>x?.name===name);if(!t)throw new Error('iHateAudio page tool not found: '+name);return t.execute(input)},{name,input})}
async function waitTools(page:any){for(let i=0;i<100;i++){if(await page.evaluate(()=>Array.isArray((globalThis as any).__ihaAgentTools)&&((globalThis as any).__ihaAgentTools||[]).some((t:any)=>t?.name==='inspect_audio')))return;await sleep(200)}throw new Error('iHateAudio did not expose its WebMCP tools.')}
async function waitLoaded(page:any){for(let i=0;i<360;i++){const x=await page.evaluate(()=>{const w=document.querySelector('[data-workspace]'),d=document.querySelector('[data-drop]');return !!(w&&!w.hasAttribute('hidden'))||!!(d?.hasAttribute('hidden'))});if(x)return;await sleep(250)}throw new Error('The audio file did not finish loading.')}
async function analysis(page:any,slug:string){for(let i=0;i<360;i++){const x=await page.evaluate((s)=>{const t=(q:string)=>document.querySelector(q)?.textContent?.trim()||null;if(s==='bpm-detector'){const bpm=t('[data-bpm]');return {ready:!!bpm&&bpm!=='···',bpm,confidence:t('[data-confidence]'),explanation:t('[data-confidence-text]'),halfTime:t('[data-reading="half"]'),main:t('[data-reading="main"]'),doubleTime:t('[data-reading="double"]')}}if(s==='key-finder'){const k=t('[data-key-name]');return {ready:!!k,key:k,camelot:t('[data-key-camelot]'),confidence:t('[data-key-confidence]'),secondChoice:t('[data-key-second]')}}const i=t('[data-stat="integrated"]');return {ready:!!i&&i!=='···',integrated:i,range:t('[data-stat="range"]'),truePeak:t('[data-stat="truepeak"]'),peak:t('[data-stat="peak"]')};},slug);if((x as any).ready)return x;await sleep(250)}throw new Error(title(slug)+' analysis timed out.')}
async function exportPage(page:any,env:McpEnv,format?:string){const p=page.waitForEvent('download',{timeout:TIMEOUT}).catch(()=>null);await siteTool(page,'export_download',format?{format}:{});const first=await Promise.race([p,sleep(1500).then(()=>null)]);const out:any[]=[];if(first)out.push(await saveDownload(env,first));const n=await page.locator('[data-results] .result button').count();for(let i=0;i<n;i++){const q=page.waitForEvent('download',{timeout:TIMEOUT}).catch(()=>null);await page.locator('[data-results] .result button').nth(i).click();const d=await q;if(d)out.push(await saveDownload(env,d))}if(!out.length)throw new Error('iHateAudio finished without producing a downloadable file.');return out}
async function waveform(page:any,env:McpEnv){const b=page.locator('[data-png-download]');await b.waitFor({state:'visible',timeout:20_000});const q=page.waitForEvent('download',{timeout:TIMEOUT});await b.click();return [await saveDownload(env,await q)]}

async function run(env:McpEnv,slug:string,files:z.infer<typeof FILE>[],settings:any,outputFormat?:string,bitrateKbps?:number){
  if(slug==='voice-recorder')return {tool:title(slug),available:false,url:ORIGIN+'/voice-recorder',reason:'Live microphone capture requires an interactive browser permission prompt and cannot be delegated to a remote MCP worker. Use the iHateAudio recorder page directly, then upload the recording for processing.'};
  if(!MULTI.has(slug)&&files.length!==1)throw new Error(title(slug)+' accepts one input file.');
  const browser=await launch(env.BROWSER),page=await browser.newPage(); page.setDefaultTimeout(120_000); const keys:string[]=[];
  try{await bridge(page);await page.goto(ORIGIN+'/'+slug,{waitUntil:'domcontentloaded',timeout:120_000});await waitTools(page);
    if(MULTI.has(slug)){for(const f of files){const x=await stage(env,f);keys.push(x.key);const rr=await siteTool(page,'load_audio_from_url',{url:x.url}); if(!rr)throw new Error('Could not load input file.')}await waitLoaded(page)}
    else{const x=await stage(env,files[0]);keys.push(x.key);await siteTool(page,'load_audio_from_url',{url:x.url});await waitLoaded(page)}
    const a=ACTIONS[slug];if(a)await siteTool(page,a.name,settings||{});
    if(outputFormat||bitrateKbps!==undefined)await siteTool(page,'set_output_format',{...(outputFormat?{format:outputFormat}:{}),...(bitrateKbps!==undefined?{bitrateKbps}:{} )});
    if(ANALYSIS.has(slug))return await analysis(page,slug);
    if(slug==='waveform-generator')return await waveform(page,env);
    return await exportPage(page,env,outputFormat);
  }finally{await Promise.all(keys.map(k=>env.MODELS.delete(k)));await browser.close()}
}

function register(server:McpServer,env:McpEnv){for(const slug of SLUGS){const needs=slug!=='voice-recorder',a=ACTIONS[slug],desc=['Run the real '+title(slug)+' implementation from ihateaudio.com.',needs?'The supplied media file is loaded into the same browser implementation used by the site.':'Opens the live microphone recorder page because microphone permission cannot be delegated to a remote worker.'];if(a)desc.push('Settings: '+a.name+'('+a.params+'), supplied in settings.');if(ANALYSIS.has(slug))desc.push('Returns analysis data instead of a file.');else if(slug==='waveform-generator')desc.push('Returns the generated PNG.');else desc.push('Optional outputFormat and bitrateKbps are supported where the page supports them.');
  const shape:any={};if(needs)shape.files=FILES.describe(MULTI.has(slug)?'Input files in processing order.':'One input media file.');if(a)shape.settings=z.record(z.string(),z.unknown()).optional().describe('Parameters for '+a.name+': '+a.params+'.');if(needs&&!ANALYSIS.has(slug)&&slug!=='waveform-generator'){shape.outputFormat=z.string().optional();shape.bitrateKbps=z.number().positive().optional()}
  const meta:any=needs?{'openai/fileParams':['files']}:{};
  server.registerTool(slugName(slug),{title:title(slug),description:desc.join(' '),inputSchema:shape,annotations:{readOnlyHint:ANALYSIS.has(slug),openWorldHint:false,destructiveHint:false},_meta:meta},async(input:any)=>{try{const result=await run(env,slug,needs?input.files:[],input.settings||{},input.outputFormat,input.bitrateKbps);if(Array.isArray(result)&&result[0]?.url)return {content:[{type:'text',text:result.length===1?'iHateAudio finished '+title(slug)+'.':'iHateAudio finished '+title(slug)+' and produced '+result.length+' files.'},...result.map((x:any)=>({type:'resource_link',uri:x.url,name:x.name,mimeType:x.mime,description:'Processed output from iHateAudio.'}))]};return {content:[{type:'text',text:JSON.stringify(result)}]}}catch(e){return {isError:true,content:[{type:'text',text:e instanceof Error?e.message:'iHateAudio processing failed.'}]}}});}}

export function handleMcp(request:Request,env:McpEnv,ctx:ExecutionContext){return createMcpHandler(()=>{const s=new McpServer({name:'ihateaudio',version:'0.2.0'});register(s,env);return s},{route:'/mcp'})(request,env,ctx)}
export async function serveMcpFile(request:Request,env:McpEnv){const m=new URL(request.url).pathname.match(/^\/mcp-files\/(input|output)\/([^/]+)(?:\/.*)?$/);if(!m)return new Response('Not found',{status:404});const prefix=m[1]==='input'?INPUT:OUTPUT,obj=await env.MODELS.get(prefix+m[2]);if(!obj)return new Response('Not found',{status:404});const exp=Number(obj.customMetadata?.expiresAt||0);if(exp&&exp<Date.now()){await env.MODELS.delete(prefix+m[2]);return new Response('Expired',{status:410})}const h=new Headers();obj.writeHttpMetadata(h);h.set('etag',obj.httpEtag);h.set('access-control-allow-origin','*');h.set('x-content-type-options','nosniff');return request.method==='HEAD'?new Response(null,{headers:h}):new Response(obj.body,{headers:h})}
async function clean(bucket:R2Bucket,prefix:string){let cursor:string|undefined;do{const x=await bucket.list({prefix,limit:1000,cursor});const now=Date.now();const dead=x.objects.filter(o=>Number(o.customMetadata?.expiresAt||0)>0&&Number(o.customMetadata?.expiresAt||0)<now);if(dead.length)await Promise.all(dead.map(o=>bucket.delete(o.key)));cursor=x.truncated?x.cursor:undefined}while(cursor)}
export const cleanupMcpFiles=(env:McpEnv)=>Promise.all([clean(env.MODELS,INPUT),clean(env.MODELS,OUTPUT)]);

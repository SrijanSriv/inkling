import OpenAI from "openai";
import { readFileSync } from "node:fs";
import type { ResponseParams, Responses, ResponseStream } from "./ai.js";

// Gemini's Chat Completions API behind the same Responses interface as every other model.
// The raw assistant message preserves Gemini thought signatures across tool steps, only in RAM.
const RAW = "gemini:";
type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Completion = OpenAI.Chat.Completions.ChatCompletion;
type Body = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Item = { type?: string; role?: string; content?: string | { type: string; text?: string; refusal?: string; image_url?: string | null }[];
  name?: string; arguments?: string; call_id?: string; output?: unknown; encrypted_content?: string | null };

let client: OpenAI | undefined;
function gemini(): OpenAI {
  if (client) return client;
  const file = process.env.INKLING_GEMINI_API_KEY_FILE;
  const apiKey = process.env.GEMINI_API_KEY?.trim() || (file ? readFileSync(file,"utf8").trim() : "");
  if (!apiKey) throw new Error("Set GEMINI_API_KEY or INKLING_GEMINI_API_KEY_FILE for Gemini.");
  return client = new OpenAI({ baseURL:"https://generativelanguage.googleapis.com/v1beta/openai/", apiKey,
    timeout: 90_000, maxRetries: 0 }); // Quota failures should surface, rather than repeat behind the user's back.
}

function messagesOf(params: ResponseParams): Message[] {
  const messages: Message[] = params.instructions ? [{ role:"system", content:params.instructions }] : [];
  const items: Item[] = typeof params.input === "string" ? [{role:"user",content:params.input}] : (params.input ?? []) as Item[];
  let echoed = false;
  for (const item of items) {
    if (item.type === "reasoning" && item.encrypted_content?.startsWith(RAW)) {
      const raw = JSON.parse(item.encrypted_content.slice(RAW.length)) as Message;
      if (raw.role !== "assistant") throw new Error("Invalid Gemini continuation.");
      messages.push(raw);
      echoed = true;
    } else if (item.type === "function_call_output") {
      messages.push({role:"tool",tool_call_id:item.call_id!,content:typeof item.output === "string" ? item.output : JSON.stringify(item.output)});
    } else if (item.type === "function_call") {
      if (echoed) continue;
      const call: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall = {
        id:item.call_id!,type:"function",function:{name:item.name!,arguments:item.arguments || "{}"},
      };
      const last = messages.at(-1);
      if (last?.role === "assistant") last.tool_calls = [...last.tool_calls ?? [],call];
      else messages.push({role:"assistant",content:null,tool_calls:[call]});
    } else if (item.role) {
      if (item.role === "assistant" && echoed) continue;
      echoed = false;
      const parts = typeof item.content === "string" ? item.content : (item.content ?? []).flatMap((p): OpenAI.Chat.Completions.ChatCompletionContentPart[] => {
        if (p.type === "input_image" && p.image_url) return [{type:"image_url",image_url:{url:p.image_url}}];
        return p.text || p.refusal ? [{type:"text",text:p.text || p.refusal!}] : [];
      });
      if (item.role === "assistant") {
        messages.push({role:"assistant",content:typeof parts === "string" ? parts : parts.flatMap(p=>p.type === "text" ? [p.text] : []).join("\n")});
      } else messages.push({role:"user",content:parts});
    }
  }
  return messages;
}

function bodyOf(params: ResponseParams): Body {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = (params.tools ?? []).map(tool => {
    if (tool.type !== "function") throw new Error("Gemini hosted search is not configured. Use the browser tools or disable INKLING_WEB_SEARCH.");
    return {type:"function",function:{name:tool.name,description:tool.description ?? undefined,parameters:tool.parameters ?? {type:"object",properties:{}}}};
  });
  const effort = params.reasoning?.effort ?? "minimal";
  const format = params.text?.format;
  const choice = params.tool_choice;
  return {
    model:String(params.model), messages:messagesOf(params), max_tokens:params.max_output_tokens ?? 16_384,
    ...(effort && {reasoning_effort: effort === "none" ? "minimal" : effort === "xhigh" ? "high" : effort}),
    ...(tools.length && {tools}),
    ...(typeof choice === "string" && {tool_choice:choice}),
    ...(choice && typeof choice === "object" && choice.type === "function" && {tool_choice:{type:"function" as const,function:{name:choice.name}}}),
    ...(format?.type === "json_schema" && {response_format:{type:"json_schema" as const,json_schema:{name:format.name,schema:format.schema,strict:format.strict ?? undefined}}}),
    ...(format?.type === "json_object" && {response_format:{type:"json_object" as const}}),
    ...(params.temperature != null && {temperature:params.temperature}),
  };
}

function responseOf(completion: Completion): OpenAI.Responses.Response {
  const choice = completion.choices[0];
  if (!choice || !choice.finish_reason) throw new Error("Gemini returned no completed reply.");
  // A truncated tool argument must never reach the executor, even if it happens to be valid JSON.
  if (choice.finish_reason === "length") throw new Error("Gemini's reply exceeded its output limit. Please try a shorter request.");
  const message = choice.message;
  // Do not replay SDK-only fields or null refusal values: Gemini rejects those as message input.
  const carry = {role:"assistant",content:message.content || message.refusal || null,
    ...(message.tool_calls?.length && {tool_calls:message.tool_calls}),
    ...("extra_content" in message && message.extra_content != null && {extra_content:message.extra_content})};
  const output: OpenAI.Responses.ResponseOutputItem[] = [{type:"reasoning",id:`rs_${completion.id}`,summary:[],encrypted_content:RAW+JSON.stringify(carry)}];
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") throw new Error("Unsupported Gemini tool call.");
    output.push({type:"function_call",id:call.id,call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:"completed"});
  }
  const text = message.content ?? "";
  if (text || message.refusal) output.push({type:"message",id:`msg_${completion.id}`,role:"assistant",status:"completed",content:message.refusal
    ? [{type:"refusal",refusal:message.refusal}] : [{type:"output_text",text,annotations:[]}]});
  const usage = completion.usage;
  return {
    id:completion.id,object:"response",created_at:completion.created,model:completion.model,status:"completed",
    output,output_text:text,usage:usage ? {input_tokens:usage.prompt_tokens,output_tokens:usage.completion_tokens,total_tokens:usage.total_tokens,
      input_tokens_details:{cached_tokens:usage.prompt_tokens_details?.cached_tokens ?? 0},
      output_tokens_details:{reasoning_tokens:usage.completion_tokens_details?.reasoning_tokens ?? 0}} : undefined,
  } as OpenAI.Responses.Response;
}

async function streamed(params: ResponseParams, added: (name: string)=>void,
  text: (event: {delta:string;itemId:string})=>void, options?: {signal?:AbortSignal}): Promise<OpenAI.Responses.Response> {
  // Gemini sometimes omits tool-call indexes. Consume raw chunks instead of the SDK accumulator,
  // using call IDs to join fragments and retaining the provider's signature metadata unchanged.
  const stream = await gemini().chat.completions.create({...bodyOf(params),stream:true,stream_options:{include_usage:true}},options);
  const calls = new Map<number, OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall>();
  const byId = new Map<string,number>();
  const announced = new Set<number>();
  const message: Completion["choices"][number]["message"] = {role:"assistant",content:"",refusal:null};
  let id = "", model = String(params.model), created = Math.floor(Date.now()/1000);
  let finish: Completion["choices"][number]["finish_reason"] | undefined;
  let usage: Completion["usage"];
  for await (const chunk of stream) {
    id = chunk.id || id; model = chunk.model || model; created = chunk.created || created;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const {content,refusal,tool_calls,...extra} = choice.delta;
    Object.assign(message,extra);
    if (content) {message.content = (message.content || "") + content;text({delta:content,itemId:"gemini-visible-answer"});}
    if (refusal) message.refusal = (message.refusal || "") + refusal;
    if ((message.content?.length ?? 0) > 262144) throw new Error("Oversized Gemini reply.");
    for (const part of tool_calls ?? []) {
      let index = part.index;
      if (index == null) {
        if (part.id) index = byId.get(part.id) ?? Math.max(-1,...calls.keys())+1;
        else if (calls.size === 1 && tool_calls?.length === 1) index = [...calls.keys()][0];
        else throw new Error("Gemini returned an ambiguous tool fragment.");
      }
      if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error("Invalid Gemini tool index.");
      let call = calls.get(index);
      if (!call) { call = {id:"",type:"function",function:{name:"",arguments:""}}; calls.set(index,call); }
      if (part.id) {
        if (byId.has(part.id) && byId.get(part.id) !== index) throw new Error("Gemini changed a tool call index.");
        if (call.id && call.id !== part.id) throw new Error("Gemini changed a tool call ID.");
        call.id = part.id; byId.set(part.id,index);
      }
      const {index:_index,function:fn,id:_id,type,...metadata} = part;
      if (type && type !== "function") throw new Error("Unsupported Gemini tool call.");
      Object.assign(call,metadata);
      if (fn?.name && fn.name !== call.function.name) call.function.name += fn.name;
      if (fn?.arguments) call.function.arguments += fn.arguments;
      if (call.function.arguments.length > 262144) throw new Error("Oversized Gemini tool arguments.");
      if (call.function.name && !announced.has(index)) {announced.add(index);added(call.function.name);}
    }
  }
  if (!finish || !id) throw new Error("Gemini's reply stream ended before completion.");
  if (calls.size) {
    message.tool_calls = [...calls].sort(([a],[b])=>a-b).map(([,call])=>{
      if (!call.id || !call.function.name) throw new Error("Incomplete Gemini tool call.");
      return call;
    });
  }
  return responseOf({id,model,created,object:"chat.completion",choices:[{index:0,message,finish_reason:finish,logprobs:null}],usage});
}

export function geminiResponses(): Responses {
  return {
    create: async (params,options) => responseOf(await gemini().chat.completions.create(bodyOf(params),options)),
    stream: (params,options): ResponseStream => {
      const listeners: ((event: {item:OpenAI.Responses.ResponseOutputItem})=>void)[] = [];
      const textListeners: ((event: {delta:string;itemId:string})=>void)[] = [];
      let pending: Promise<OpenAI.Responses.Response> | undefined;
      return {
        on: (_event,listener)=>listeners.push(listener),
        onText: listener=>textListeners.push(listener),
        finalResponse: () => pending ??= streamed(params,name=>{
          for (const listener of listeners) listener({item:{type:"function_call",name} as OpenAI.Responses.ResponseFunctionToolCall});
        },event=>{for(const listener of textListeners)listener(event);},options),
      };
    },
  };
}

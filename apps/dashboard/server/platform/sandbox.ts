import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExternalAgentOptions } from "@eigen/external-runner";
import { Sandbox } from "e2b";
import { safeRepoPath } from "./security.js";
import { PlatformError } from "./types.js";

export interface RepositorySandbox {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  command(
    command: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  files(): Promise<Record<string, string>>;
  offline(): Promise<void>;
  launch: NonNullable<ExternalAgentOptions["launch"]>;
  close(): Promise<void>;
}
export interface SandboxProvider {
  create(
    files: Record<string, string>,
    signal: AbortSignal,
  ): Promise<RepositorySandbox>;
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

// Runs inside E2B. No persistent credential is embedded here. The parent worker
// services fixed payment/model RPCs through the SDK's authenticated stdio stream.
export const relaySource = String.raw`
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const pending = new Map(); let sequence = 0; let child;
const send = (value) => process.stdout.write(JSON.stringify(value)+'\n');
async function proxy(kind) {
 const server = http.createServer(async(req,res)=>{
  let bytes=0; const chunks=[];
  for await (const chunk of req) { bytes+=chunk.length; if(bytes>262144){res.writeHead(413);res.end();return;} chunks.push(chunk); }
  const id=String(++sequence); pending.set(id,res);
  send({kind:'rpc',target:kind,id,path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,url:'http://127.0.0.1:'+server.address().port};
}
createInterface({input:process.stdin}).on('line',async(line)=>{
 try {
  const value=JSON.parse(line);
  if(value.kind==='start') {
   const payment=await proxy('payment'); const model=await proxy('model');
   child=spawn(process.execPath,[value.entrypoint],{cwd:'/home/user/repo',env:{PATH:process.env.PATH,HOME:'/home/user',OPENAI_API_KEY:'eigen-run-scoped',OPENAI_MODEL:value.model,OPENAI_BASE_URL:model.url+'/v1',EIGEN_PAYMENT_BASE_URL:payment.url,EIGEN_PAYMENT_TOKEN:'eigen-run-scoped'},stdio:['pipe','pipe','pipe']});
   child.stdout.on('data',data=>send({kind:'stdout',data:data.toString()}));
   child.stderr.on('data',data=>send({kind:'stderr',data:data.toString()}));
   child.on('error',()=>send({kind:'exit',code:1}));
   child.on('close',code=>{send({kind:'exit',code});payment.server.close();model.server.close();process.exit(0);});
   child.stdin.end(value.input);
  } else if(value.kind==='reply') {
   const res=pending.get(value.id); if(!res)return; pending.delete(value.id);
   if(value.destroy){res.destroy();return;}
   res.writeHead(value.status,{'content-type':'application/json'});res.end(value.body);
  }
 }catch{send({kind:'exit',code:1});}
});
`;

export function createE2BProvider(
  apiKey: string,
  template = "base",
  fetcher: typeof fetch = fetch,
): SandboxProvider {
  return {
    async create(files, signal) {
      signal.throwIfAborted();
      const remote = await Sandbox.create(template, {
        apiKey,
        timeoutMs: 300000,
        network: { allowOut: ["registry.npmjs.org"], denyOut: ["0.0.0.0/0"] },
        signal,
      });
      const stop = () => {
        void remote.kill();
      };
      signal.addEventListener("abort", stop, { once: true });
      const root = "/home/user/repo";
      try {
        await remote.commands.run(`mkdir -p ${root}`, { timeoutMs: 10000 });
        for (const [path, content] of Object.entries(files))
          await remote.files.write(`${root}/${safeRepoPath(path)}`, content);
        await remote.files.write("/tmp/eigen-relay.cjs", relaySource);
      } catch (error) {
        signal.removeEventListener("abort", stop);
        await remote.kill();
        throw error;
      }
      return {
        async read(path) {
          signal.throwIfAborted();
          const text = await remote.files.read(`${root}/${safeRepoPath(path)}`);
          if (text.length > 2000000)
            throw new PlatformError(422, "File exceeds the source size limit.");
          return text;
        },
        async write(path, content) {
          signal.throwIfAborted();
          if (content.length > 2000000)
            throw new PlatformError(422, "File exceeds the source size limit.");
          await remote.files.write(`${root}/${safeRepoPath(path)}`, content);
        },
        async command(command, timeoutMs = 45000) {
          signal.throwIfAborted();
          try {
            const result = await remote.commands.run(command, {
              cwd: root,
              timeoutMs: Math.min(45000, timeoutMs),
              signal,
            });
            return {
              stdout: result.stdout.slice(-16000),
              stderr: result.stderr.slice(-8000),
              exitCode: result.exitCode,
            };
          } catch (error) {
            if (error && typeof error === "object" && "result" in error) {
              const result = error.result as {
                stdout: string;
                stderr: string;
                exitCode: number;
              };
              return {
                stdout: result.stdout.slice(-16000),
                stderr: result.stderr.slice(-8000),
                exitCode: result.exitCode,
              };
            }
            throw error;
          }
        },
        async files() {
          signal.throwIfAborted();
          const script = `const fs=require('fs'),path=require('path');let total=0,out={};function scan(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git','.eigen-runtime'].includes(item.name)||item.name.startsWith('.env'))continue;const file=path.join(dir,item.name);if(item.isSymbolicLink())throw Error('Symbolic links are unsupported');if(item.isDirectory())scan(file);else if(/\\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|lock|toml)$/.test(file)||item.name==='.gitignore'){const data=fs.readFileSync(file,'utf8');total+=Buffer.byteLength(data);if(total>20000000||Object.keys(out).length>=1500)throw Error('Source limit exceeded');out[path.relative(process.cwd(),file)]=data;}}}scan(process.cwd());process.stdout.write(JSON.stringify(out));`;
          const value = await remote.commands.run(`node -e ${quote(script)}`, {
            cwd: root,
            timeoutMs: 10000,
            signal,
          });
          const result = JSON.parse(value.stdout) as Record<string, string>;
          for (const key of Object.keys(result)) safeRepoPath(key);
          return result;
        },
        async offline() {
          await remote.updateNetwork({ allowOut: [], denyOut: ["0.0.0.0/0"] });
        },
        launch({ entrypoint, env }) {
          const processEvents = new EventEmitter();
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let input = "";
          let buffer = "";
          let bytes = 0;
          let modelCalls = 0;
          let completedModelCalls = 0;
          let closed = false;
          let handle:
            | Awaited<ReturnType<typeof remote.commands.run>>
            | undefined;
          const close = (code: number) => {
            if (closed) return;
            closed = true;
            processEvents.emit(
              "close",
              code === 0 && completedModelCalls === 0 ? 1 : code,
            );
          };
          const kill = () => {
            if (handle && "kill" in handle) void handle.kill();
            close(1);
            return true;
          };
          async function rpc(value: {
            id: string;
            target: string;
            path: string;
            method: string;
            headers: Record<string, string>;
            body: string;
          }) {
            const reply: {
              kind: string;
              id: string;
              status?: number;
              body?: string;
              destroy?: boolean;
            } = { kind: "reply", id: value.id };
            try {
              if (value.body.length > 262144 || closed)
                throw new Error("Invalid request");
              let url: string;
              let headers: Record<string, string>;
              if (value.target === "payment") {
                if (
                  !/^\/v1\/payments\/[^/?]+(?:\/refunds?)?$/.test(value.path) ||
                  !["GET", "POST"].includes(value.method)
                )
                  throw new Error("Invalid payment path");
                url = `${env.EIGEN_PAYMENT_BASE_URL}${value.path}`;
                headers = {
                  "Content-Type": "application/json",
                  "x-eigen-token": env.EIGEN_PAYMENT_TOKEN ?? "",
                  ...(value.headers["x-request-id"]
                    ? { "x-request-id": value.headers["x-request-id"] }
                    : {}),
                  ...(value.headers["x-refund-idempotency"]
                    ? {
                        "x-refund-idempotency":
                          value.headers["x-refund-idempotency"],
                      }
                    : {}),
                };
              } else {
                if (
                  value.target !== "model" ||
                  value.path !== "/v1/responses" ||
                  value.method !== "POST" ||
                  ++modelCalls > 20
                )
                  throw new Error("Invalid inference request");
                const body = JSON.parse(value.body) as Record<string, unknown>;
                if (
                  body.model !== env.OPENAI_MODEL ||
                  body.stream === true ||
                  body.background === true ||
                  body.previous_response_id ||
                  body.conversation ||
                  !Array.isArray(body.input) ||
                  (Array.isArray(body.tools) &&
                    body.tools.some(
                      (tool: { type?: string }) => tool.type !== "function",
                    ))
                )
                  throw new Error("Unsupported inference configuration");
                body.store = false;
                body.max_output_tokens = Math.min(
                  typeof body.max_output_tokens === "number"
                    ? body.max_output_tokens
                    : 4096,
                  4096,
                );
                value.body = JSON.stringify(body);
                url = "https://api.openai.com/v1/responses";
                headers = {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
                };
              }
              const result = await fetcher(url, {
                method: value.method,
                headers,
                ...(value.method === "POST" ? { body: value.body } : {}),
                signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
              });
              if (value.target === "model" && result.ok) completedModelCalls++;
              const body = await result.text();
              if (body.length > 2000000)
                throw new Error("Response limit exceeded");
              reply.status = result.status;
              reply.body = body;
            } catch {
              reply.destroy = true;
            }
            if (!closed && handle && "sendStdin" in handle)
              await handle.sendStdin(`${JSON.stringify(reply)}\n`);
          }
          stdin.on("data", (chunk) => {
            input += chunk.toString();
          });
          stdin.on("finish", () => {
            void (async () => {
              safeRepoPath(entrypoint);
              const command = await remote.commands.run(
                "node /tmp/eigen-relay.cjs",
                {
                  cwd: root,
                  stdin: true,
                  background: true,
                  timeoutMs: 120000,
                  onStdout(data) {
                    bytes += data.length;
                    if (bytes > 8000000) {
                      kill();
                      return;
                    }
                    buffer += data;
                    for (;;) {
                      const at = buffer.indexOf("\n");
                      if (at < 0) break;
                      const line = buffer.slice(0, at);
                      buffer = buffer.slice(at + 1);
                      try {
                        const value = JSON.parse(line);
                        if (value.kind === "stdout") stdout.write(value.data);
                        else if (value.kind === "stderr")
                          stderr.write(value.data);
                        else if (value.kind === "exit") close(value.code ?? 1);
                        else if (value.kind === "rpc")
                          void rpc(value).catch(kill);
                        else kill();
                      } catch {
                        kill();
                      }
                    }
                  },
                  signal,
                },
              );
              handle = command;
              await command.sendStdin(
                `${JSON.stringify({ kind: "start", entrypoint, model: env.OPENAI_MODEL, input })}\n`,
              );
              await command.wait();
              close(0);
            })().catch(() => close(1));
          });
          return Object.assign(processEvents, { stdin, stdout, stderr, kill });
        },
        async close() {
          signal.removeEventListener("abort", stop);
          await remote.kill();
        },
      };
    },
  };
}

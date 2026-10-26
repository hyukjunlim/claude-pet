#!/usr/bin/env node
'use strict';

// SNU eTL 조회 CLI (읽기 전용). Claude Pet이 eTL 토큰을 갖고 조회하며, 이 스크립트는 펫의
// 로컬 조회 브리지(Windows 이름 있는 파이프, 그 밖에는 ~/.claude-pet/etl.sock)에 요청 한 줄을
// 보내고 받은 응답을 출력한다. 의존성 없음. 이 파일은 펫이 관리하므로 고치지 않는다.
//
// The pipe path below repeats defaultPipePath() in the pet's src/etl/bridge.js; keep them in step.
// When the pipe can't be opened (Codex runs commands in a sandbox, as another Windows user), the
// request goes through files in .etl-bridge/ next to this script instead (createFileBridge there).

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOT_RUNNING = 'Claude Pet이 실행 중이 아니거나 eTL 기능이 꺼져 있습니다. 펫을 켜고 eTL을 켜 주세요.';
const TIMEOUT_MS = 35000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000 + 15000;   // the pet allows a download 5 minutes
const FILE_BRIDGE = process.env.CLAUDE_PET_ETL_DIR || path.join(__dirname, '.etl-bridge');
const PICKUP_MS = 3000;           // the pet takes a request within a poll; longer means it isn't there
const POLL_MS = 100;

const HELP = `SNU eTL 조회 CLI (읽기 전용, Claude Pet을 통해 조회)

사용법: node etl.js <명령> [옵션]

명령:
  check                                   펫과 eTL 연결 확인
  briefing                                7일 내 마감 + 미제출 + 최근 3일 공지
  courses                                 수강 과목과 현재 점수
  assignments [--status S] [--days N] [--course ID]
                                          과제 목록 (마감일 순)
                                          S: upcoming(기본) | missing | submitted | all
                                          --days: upcoming일 때 N일 이내 마감만
  assignment <과목ID> <과제ID>            과제 상세 (--course ID --id ID 형식도 가능)
  announcements [--days N] [--course ID]  최근 공지 (기본 7일, 최대 60일)
  grades [--course ID]                    과목별 점수와 채점된 과제
  files --course ID                       과목 강의자료·내 제출 파일 목록 (받지 않음)
  download <과목ID> <파일ID>              파일 하나를 강의자료/<과목명>/에 받기
                                          (--course ID --id ID 형식도 가능)
  timetable [--date YYYY-MM-DD] [--week]  그날(기본 오늘) 수업, 보강·휴강 반영
                                          --week: 과목별 주간 시간표도 함께
  boards --course ID                      과목 게시판 목록 (글 수, 안 읽은 글 수)
  posts --course ID --board ID [--page N] [--keyword 검색어]
                                          게시판 글 목록 (한 페이지 20개, 제목 검색)
  post --course ID --board ID --id ID     게시글 본문, 첨부파일 목록, 댓글
  download <과목ID> <파일ID> --board ID --post ID
                                          게시글 첨부파일 하나를 강의자료/<과목명>/에 받기
  api "<경로>" [--all]                     eTL(Canvas) API를 GET으로 그대로 조회
                                          경로는 /api/v1/로 시작, 따옴표로 감싸기
                                          --all: 목록의 다음 페이지까지 모두

공통 옵션:
  --ascii    한글 등을 \\uXXXX로 바꿔 출력 (터미널에서 글자가 깨질 때)
             Windows에서 출력이 다른 프로그램으로 갈 때는 기본으로 이렇게 출력
  -h, --help 이 도움말

토큰은 채팅에 붙여넣지 말고, 펫 트레이 메뉴의 eTL에서 등록하세요.
`;

function userTag() {
  let name = '';
  try {
    name = os.userInfo().username;
  } catch {
    // no passwd entry: fall back to the environment
  }
  name = name || process.env.USERNAME || process.env.USER || 'user';
  return name.replace(/[^\p{L}\p{N}._-]/gu, '_');
}

function pipePath() {
  if (process.env.CLAUDE_PET_ETL_PIPE) return process.env.CLAUDE_PET_ETL_PIPE;
  if (process.platform === 'win32') return `\\\\.\\pipe\\claude-pet-etl-${userTag()}`;
  return path.join(os.homedir(), '.claude-pet', 'etl.sock');
}

// Turns the command line into { help } or { request } or { error }. Values that look like whole
// numbers are sent as numbers; the pet checks everything else.
function parseArgs(argv) {
  const positional = [];
  const args = {};
  // Codex reads a command's output on Windows in the system code page, which turns UTF-8 Korean
  // into gibberish; \uXXXX escapes are plain ASCII and still valid JSON. Claude Code reads UTF-8.
  let ascii = process.platform === 'win32' && !process.stdout.isTTY && !process.env.CLAUDECODE;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '--ascii') { ascii = true; continue; }
    if (a === '--all' || a === '--week') { args[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
      else return { error: `--${key} 옵션에 값이 필요합니다.`, ascii };
      if (!key) return { error: `알 수 없는 옵션입니다: ${a}`, ascii };
      args[key] = key === 'keyword' ? value : toValue(value);   // a search word stays text
      continue;
    }
    positional.push(a);
  }
  if (help) return { help: true, ascii };
  const [cmd, ...rest] = positional;
  if (!cmd || cmd === 'help') return { help: true, ascii };
  if (cmd === 'setup') return { error: '토큰은 펫 트레이 메뉴의 eTL에서 등록합니다. 토큰을 채팅에 붙여넣지 마세요.', ascii };
  if ((cmd === 'assignment' || cmd === 'download') && rest.length > 0) {
    if (rest.length !== 2) {
      const usage = cmd === 'assignment' ? 'assignment <과목ID> <과제ID>' : 'download <과목ID> <파일ID>';
      return { error: `사용법: node etl.js ${usage}`, ascii };
    }
    args.course = toValue(rest[0]);
    args.id = toValue(rest[1]);
  } else if (cmd === 'api' && rest.length > 0) {
    if (rest.length !== 1) return { error: '사용법: node etl.js api "/api/v1/<경로>" [--all]', ascii };
    args.path = apiPath(rest[0]);
  } else if (rest.length > 0) {
    return { error: `알 수 없는 인자입니다: ${rest.join(' ')}`, ascii };
  }
  return { request: { cmd, args }, ascii };
}

// Git Bash on Windows turns an argument like /api/v1/x into C:/Program Files/Git/api/v1/x before
// node sees it, so that prefix is dropped again; "api/v1/x" without the slash is fine too.
function apiPath(s) {
  const m = /^(?:[A-Za-z]:[\\/][^?]*?)?\/?(api\/v1\/.*)$/s.exec(s.replace(/\\/g, '/'));
  return m ? `/${m[1]}` : s;
}

const toValue = (s) => (/^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s);

function format(obj, ascii, pretty = true) {
  const text = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  return ascii ? text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : text;
}

// Writes UTF-8 bytes (Node's console writer handles a Windows terminal itself) and sets the exit
// code without cutting off a pipe that's still draining.
function output(text, code) {
  process.stdout.write(Buffer.from(`${text}\n`, 'utf8'));
  process.exitCode = code;
}

// How long to wait for the pet: a download may take minutes.
const timeoutFor = (request) => (request.cmd === 'download' ? DOWNLOAD_TIMEOUT_MS : TIMEOUT_MS);

function ask(request) {
  return new Promise((resolve) => {
    const socket = net.connect(pipePath());
    const chunks = [];
    let connected = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: '펫에서 응답이 없습니다. 잠시 후 다시 시도해 주세요.' }), timeoutFor(request));
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (chunk.includes(0x0a)) finish(parse(Buffer.concat(chunks)));
    });
    socket.on('end', () => finish(parse(Buffer.concat(chunks))));
    socket.on('close', () => finish(parse(Buffer.concat(chunks))));
    socket.on('error', () => finish(connected ? parse(Buffer.concat(chunks)) : { notRunning: true }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function removeSafe(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// The same request through files: requests/<id>.json in, responses/<id>.json out. The pet
// removes a request as it takes it, so one still there after PICKUP_MS means no pet.
async function askByFile(request) {
  const requests = path.join(FILE_BRIDGE, 'requests');
  const responses = path.join(FILE_BRIDGE, 'responses');
  if (!fs.existsSync(requests)) return { notRunning: true };
  const id = crypto.randomUUID();
  const file = path.join(requests, `${id}.json`);
  const answer = path.join(responses, `${id}.json`);
  try {
    fs.writeFileSync(path.join(requests, `${id}.tmp`), `${JSON.stringify(request)}\n`);
    fs.renameSync(path.join(requests, `${id}.tmp`), file);
  } catch {
    removeSafe(path.join(requests, `${id}.tmp`));
    return { notRunning: true };
  }
  const started = Date.now();
  const limit = timeoutFor(request);
  while (Date.now() - started < limit) {
    await sleep(POLL_MS);
    let buf = null;
    try {
      buf = fs.readFileSync(answer);
    } catch {
      // not answered yet
    }
    if (buf) {
      removeSafe(answer);
      return parse(buf);
    }
    if (Date.now() - started > PICKUP_MS && fs.existsSync(file)) {
      removeSafe(file);
      return { notRunning: true };
    }
  }
  removeSafe(file);
  return { error: '펫에서 응답이 없습니다. 잠시 후 다시 시도해 주세요.' };
}

function parse(buf) {
  const line = buf.toString('utf8').split('\n')[0].trim();
  if (!line) return { error: '펫에서 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    // fall through
  }
  return { error: '펫의 응답을 읽을 수 없습니다.' };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    output(HELP.trimEnd(), 0);
    return;
  }
  if (parsed.error) {
    output(format({ error: parsed.error }, parsed.ascii), 2);
    return;
  }
  let res = await ask(parsed.request);
  if (res.notRunning) res = await askByFile(parsed.request);
  if (res.notRunning) {
    output(format({ error: NOT_RUNNING }, parsed.ascii, false), 1);
    return;
  }
  output(format(res, parsed.ascii), Object.hasOwn(res, 'error') ? 1 : 0);
}

main();

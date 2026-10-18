// Fail before importing application code if a private mount or host route is exposed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
for(const target of ['/home','/root','/run/user','/workspace/.env','/workspace/data','/workspace/.git']) assert.equal(fs.existsSync(target),false,'Private path exposed');
assert.equal(fs.readFileSync('/proc/net/route','utf8').trim().split('\n').length,1,'Host network route exposed');
for(const key of Object.keys(process.env)) assert(['PWD','PATH','HOME','INKLING_DATA_DIR','AUDIT_SCRATCH','AUDIT_SOURCE_ROOT','INKLING_SECRET_KEY'].includes(key),'Unexpected inherited environment');
assert.equal(process.env.PWD,process.env.AUDIT_SCRATCH,'Unexpected working directory');

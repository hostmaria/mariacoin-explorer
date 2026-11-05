#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 0077

[[ $# -eq 1 ]] || { echo 'usage: verify-eiquidus-backup.sh BACKUP_DIRECTORY' >&2; exit 1; }
backup=$(readlink -f "$1")
root=/var/backups/mariacoin-explorer
[[ $backup == "$root"/* && -d $backup && ! -L $backup ]] || { echo 'unsafe backup directory' >&2; exit 1; }
verification_marker=/var/lib/eiquidus/BACKUP_VERIFIED.json
rm -f "$verification_marker"
credential_file=/etc/eiquidus/mongodb-admin.json
config=''

drop_restore_database() {
  cd /opt/eiquidus/current
  /usr/local/bin/node - <<'NODE'
const fs=require('fs'),{MongoClient}=require('./node_modules/mongodb'),c=JSON.parse(fs.readFileSync('/etc/eiquidus/mongodb-admin.json'));
const u=`mongodb://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@127.0.0.1:27017/admin?authSource=admin&replicaSet=mariacoin-rs`;
(async()=>{const m=new MongoClient(u);try{await m.connect();await m.db('mariacoin_restore_test').dropDatabase()}finally{await m.close()}})().catch(e=>{console.error(e.message);process.exit(1)});
NODE
}
cleanup() {
  status=$?
  trap - EXIT
  set +e
  cleanup_failed=false
  rm -f "$config" || cleanup_failed=true
  if ! drop_restore_database >/dev/null; then cleanup_failed=true; fi
  if [[ $cleanup_failed == true ]]; then
    echo 'failed to completely clean isolated backup verification state' >&2
    rm -f "$verification_marker" || true
    status=70
  fi
  exit "$status"
}
trap cleanup EXIT
config=$(mktemp /run/mariacoin-restore-mongodb.XXXXXX.yml)

(cd "$backup" && sha256sum -c SHA256SUMS)
python3 - "$credential_file" "$config" <<'PY'
import json, pathlib, sys
from urllib.parse import quote
source, output = map(pathlib.Path, sys.argv[1:])
c = json.loads(source.read_text())
output.write_text(
    f'uri: "mongodb://{quote(c["username"], safe="")}@127.0.0.1:27017/?authSource=admin&replicaSet=mariacoin-rs"\n'
    f'password: {json.dumps(c["password"])}\n'
)
output.chmod(0o600)
PY

drop_restore_database
mongorestore --config="$config" --archive="$backup/mongodb.archive.gz" --gzip --nsInclude='mariacoin.*' --nsFrom='mariacoin.*' --nsTo='mariacoin_restore_test.*'
cd /opt/eiquidus/current
/usr/local/bin/node - "$backup/DATABASE-MANIFEST.json" <<'NODE'
const fs=require('fs'),{MongoClient}=require('./node_modules/mongodb'),c=JSON.parse(fs.readFileSync('/etc/eiquidus/mongodb-admin.json'));
const manifest=JSON.parse(fs.readFileSync(process.argv[2])),u=`mongodb://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@127.0.0.1:27017/admin?authSource=admin&replicaSet=mariacoin-rs`;
(async()=>{const m=new MongoClient(u);try{
  await m.connect();
  const restored=m.db('mariacoin_restore_test');
  const names=(await restored.listCollections({}, {nameOnly:true}).toArray()).map(x=>x.name).sort();
  if(JSON.stringify(names)!==JSON.stringify(manifest.collections))throw Error('restored collection set mismatch');
  for(const name of names){
    const count=await restored.collection(name).countDocuments();
    // BEGIN RESTORED COUNT POLICY
    const expectedCount=manifest.counts?.[name];
    if(!Number.isSafeInteger(expectedCount)||expectedCount<0)throw Error(`invalid manifest count for ${name}`);
    if(!Number.isSafeInteger(count)||count<0)throw Error(`invalid restored count for ${name}`);
    if(name==='claimchallenges'){
      // TTL deletion may legitimately remove short-lived challenges while a large archive restores.
      if(count>expectedCount)throw Error(`challenge count increased during restore: ${count} > ${expectedCount}`);
    }else if(count!==expectedCount){
      throw Error(`count mismatch for ${name}: ${count} != ${expectedCount}`);
    }
    // END RESTORED COUNT POLICY
  }
  const exactKey=(index,key)=>Object.keys(index.key||{}).length===1&&index.key[key]===1;
  const exactOptions=(index,options={})=>{
    if(options.name&&index.name!==options.name)return false;
    if(Boolean(index.unique)!==Boolean(options.unique))return false;
    if(Object.prototype.hasOwnProperty.call(index,'partialFilterExpression')||index.sparse===true||
       Object.prototype.hasOwnProperty.call(index,'collation')||index.hidden===true)return false;
    return Object.prototype.hasOwnProperty.call(options,'expireAfterSeconds')
      ? index.expireAfterSeconds===options.expireAfterSeconds
      : !Object.prototype.hasOwnProperty.call(index,'expireAfterSeconds');
  };
  const claimIndexes=await restored.collection('claimaddresses').indexes();
  const challengeIndexes=await restored.collection('claimchallenges').indexes();
  const statsIndexes=await restored.collection('coinstats').indexes();
  const addressTxIndexes=await restored.collection('addresstxes').indexes();
  if(!claimIndexes.some(i=>exactKey(i,'a_id')&&exactOptions(i,{name:'a_id_1',unique:true})))throw Error('restored Claim address unique index missing');
  if(!challengeIndexes.some(i=>exactKey(i,'challenge_id')&&exactOptions(i,{name:'challenge_id_1',unique:true})))throw Error('restored challenge unique index missing');
  if(!challengeIndexes.some(i=>exactKey(i,'expires_at')&&exactOptions(i,{name:'expires_at_1',expireAfterSeconds:0})))throw Error('restored challenge TTL index missing');
  if(!statsIndexes.some(i=>exactKey(i,'coin')&&exactOptions(i,{name:'coin_1',unique:true})))throw Error('restored Stats coin unique index missing');
  if(!addressTxIndexes.some(i=>JSON.stringify(i.key||{})===JSON.stringify({a_id:1,txid:1,role:1})&&exactOptions(i,{name:'a_id_1_txid_1_role_1',unique:true})))throw Error('restored AddressTx projection unique index missing');
  const claims=new Map((await restored.collection('claimaddresses').find({claim_name:{$ne:''}}).toArray()).map(x=>[x.a_id,x.claim_name]));
  for(const rich of await restored.collection('richlists').find({}).toArray())for(const field of ['received','balance'])for(const row of rich[field]||[]){
    const expected=claims.get(row.a_id)||'';
    if((row.claim_name||'')!==expected)throw Error(`restored rich-list Claim projection mismatch for ${row.a_id}`);
  }
  for(const row of await restored.collection('masternodes').find({}).toArray()){
    const expected=claims.get(row.addr)||'';
    if((row.claim_name||'')!==expected)throw Error(`restored Masternode Claim projection mismatch for ${row.addr}`);
  }
  const stats=await restored.collection('coinstats').findOne({coin:'MariaCoin'});
  if(!stats||stats.txes!==manifest.counts.txes)throw Error('restored Stats transaction count mismatch');
  if(!stats||stats.last!==manifest.stats.last||stats.txes!==manifest.stats.txes)throw Error('restored cursor/count mismatch');
  console.log(`BACKUP_RESTORE_VERIFIED collections=${names.length} last=${stats.last} txes=${stats.txes} activeClaims=${claims.size}`);
}finally{await m.close()}})().catch(e=>{console.error(e.message);process.exit(1)});
NODE

drop_restore_database
python3 - "$backup" "$verification_marker" <<'PY'
import datetime, hashlib, json, os, pathlib, stat, sys, tempfile
backup, marker = map(pathlib.Path, sys.argv[1:])
manifest = backup / 'DATABASE-MANIFEST.json'
checksums = backup / 'SHA256SUMS'
archive = backup / 'mongodb.archive.gz'
for required in (manifest, checksums, archive):
    metadata = required.lstat()
    if not stat.S_ISREG(metadata.st_mode) or required.is_symlink():
        raise SystemExit(f'unsafe backup member: {required.name}')
release = pathlib.Path('/opt/eiquidus/current').resolve()
evidence = {
    'schemaVersion': 1,
    'backup': str(backup),
    'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
    'checksumsSha256': hashlib.sha256(checksums.read_bytes()).hexdigest(),
    'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'release': str(release),
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
fd, temporary = tempfile.mkstemp(prefix='.BACKUP_VERIFIED.', dir=marker.parent)
try:
    with os.fdopen(fd, 'w') as output:
        json.dump(evidence, output, sort_keys=True)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, marker)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
cleanup

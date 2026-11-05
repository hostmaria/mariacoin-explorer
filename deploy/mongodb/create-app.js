const fs = require('fs');
const admin = JSON.parse(fs.readFileSync('/etc/eiquidus/mongodb-admin.json'));
const app = JSON.parse(fs.readFileSync('/etc/eiquidus/mongodb-app.json'));
const adb = db.getSiblingDB('admin');
adb.createUser({user: admin.username, pwd: admin.password, roles: [{role: 'root', db: 'admin'}]});
if (!adb.auth(admin.username, admin.password)) throw new Error('MongoDB administrator authentication failed');
const mdb = db.getSiblingDB('mariacoin');
mdb.createUser({user: app.username, pwd: app.password, roles: [{role: 'readWrite', db: 'mariacoin'}]});

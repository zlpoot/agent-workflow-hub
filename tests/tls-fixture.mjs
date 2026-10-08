// Ephemeral test certificates only; production keys/certificates are OS-provisioned.
import { generateKeyPairSync, sign } from 'node:crypto';
const der = (tag, bytes) => {
  bytes = Buffer.from(bytes); const length = bytes.length;
  const sizes = length < 128 ? [length] : length < 256 ? [0x81,length] : [0x82,length >> 8,length & 255];
  return Buffer.concat([Buffer.from([tag,...sizes]),bytes]);
};
const seq = (...v) => der(0x30,Buffer.concat(v));
const oid = hex => der(6,Buffer.from(hex,'hex'));
const algorithm = seq(oid('2a864886f70d01010b'),der(5,[]));
const name = text => seq(der(0x31,seq(oid('550403'),der(0x0c,Buffer.from(text)))));
const extension = (id, data, critical = false) => seq(oid(id),...(critical ? [der(1,[255])] : []),der(4,data));
const pem = (label, bytes) => Buffer.from(`-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`);
export function tlsFixture({ ip = '127.0.0.1', expired = false, caExpired = false } = {}) {
  const root = generateKeyPairSync('rsa',{modulusLength:2048}), leaf = generateKeyPairSync('rsa',{modulusLength:2048});
  const issuer = name('AWH ephemeral test CA');
  const certificate = (keys, ca, expired) => {
    const extensions = ca ? [extension('551d13',seq(der(1,[255])),true),extension('551d0f',der(3,[1,6]),true)] :
      [extension('551d13',seq(),true),extension('551d0f',der(3,[5,0xa0]),true),extension('551d25',seq(oid('2b06010505070301'))),extension('551d11',seq(der(0x87,ip.split('.').map(Number))))];
    const body = seq(der(0xa0,der(2,[2])),der(2,[ca ? 1 : 2]),algorithm,issuer,
      seq(der(0x17,Buffer.from('200101000000Z')),der(0x17,Buffer.from(expired ? '210101000000Z' : '400101000000Z'))),
      ca ? issuer : name('AWH ephemeral test leaf'),keys.publicKey.export({type:'spki',format:'der'}),der(0xa3,seq(...extensions)));
    return pem('CERTIFICATE',seq(body,algorithm,der(3,Buffer.concat([Buffer.from([0]),sign('sha256',body,root.privateKey)]))));
  };
  return { ca:certificate(root,true,caExpired), cert:certificate(leaf,false,expired), key:Buffer.from(leaf.privateKey.export({type:'pkcs8',format:'pem'})) };
}

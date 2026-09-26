const { generateKeyPairSync, publicEncrypt, privateDecrypt, constants } = require("node:crypto")
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
// 客户端路径：pubKey PEM(SPKI) + publicEncrypt(PKCS1) JSON{username,password}
const pubPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const enc = publicEncrypt({ key: pubPem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(JSON.stringify({ username: "admin", password: "Secret12345" }), "utf8")).toString("base64")
// 服务端路径：privateDecrypt(PKCS1) + JSON.parse
const dec = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(enc, "base64")).toString("utf8")
const obj = JSON.parse(dec)
console.log("decrypted:", JSON.stringify(obj))
console.log(obj.username === "admin" && obj.password === "Secret12345" ? "RSA SYMMETRY PASS" : "RSA SYMMETRY FAIL")

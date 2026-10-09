const { io } = require('socket.io-client')
const s = io('http://127.0.0.1:3458', { transports: ['websocket','polling'], auth: { device: 'hold' } })
s.on('connect', () => {
  s.timeout(8000).emit('auth:login', { account: 'vr_browser_test', password: 'pass123456', device: 'hold' }, (e, r) => {
    s.timeout(8000).emit('rtc:createMeeting', { kind: 'video' }, (e2, r2) => {
      console.log('HOLD room', r2.meeting.meetingNo, r2.meeting.type, r2.meeting.id)
      setTimeout(() => { s.close(); process.exit(0) }, 90000)
    })
  })
})
s.on('connect_error', () => { process.exit(1) })
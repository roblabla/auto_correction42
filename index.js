const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const Promise = require("bluebird");
const request = require('superagent-promise')(require('superagent'), Promise);
const qs = require('querystring');
const url = require('url');
const http = require('http');
const opn = require('opn');
const inquirer = require('inquirer');
const notifier = require('node-notifier');

Promise.config({ longStackTraces: true });

function login() {
  return new Promise(function(resolve, reject) {
    let miniserver = http.createServer(function(req, res) {
      if (req.url.startsWith("/redirect_url")) {
        const code = qs.parse(url.parse(req.url).query).code;
        miniserver.close();
        res.end("<body><script type='text/javascript'>window.close()</script>You may close this page now. The terminal has more questions for you.</body>");
        return resolve(code);
      }
    });

    miniserver.listen(9858);
    miniserver.on('listening', function() {
      // TODO: Auto-Open
      const addr = miniserver.address();
      opn("https://api.intra.42.fr/oauth/authorize?" + qs.stringify({
        'client_id': CLIENT_ID,
        'redirect_uri': 'http://127.0.0.1:' + addr.port + '/redirect_url',
        'scope': 'public projects',
        'state': 'meh',
        'response_type': 'code'
      }));
    });
  }).then(function(code) {
    return request.post("https://api.intra.42.fr/oauth/token")
      .send({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: "http://127.0.0.1:9858/redirect_url",
        state: "meh"
      })
  }).then(function(res) {
    return res.body.access_token;
  });
}

async function get_projects(tok) {
  let res = await request
    .get("https://api.intra.42.fr/v2/me")
    .set({ Authorization: 'Bearer ' + tok });
  return res.body.projects_users;
}

async function get_slots(tok, project_id) {
  res = await request
    .get("https://api.intra.42.fr/v2/projects/" + project_id + "/slots")
    .set({ 'Authorization': 'Bearer ' + tok });
  return res.body;
}

async function check_slots(tok, project_id) {
  console.log("Checking corrections");
  const slots = await get_slots(tok, project_id);
  console.log("Slots available : ", slots.length);
  if (slots.length <= 3) {
    slots.forEach(function() {
      notifier.notify({
        title: 'Correction slot spotted',
        message: 'At ' + slots[0].begin_at + ' spotted',
        actions: "Take slot",
        closeLabel: 'close'
      }, function(err, res, metadata) {
        if (err)
          throw err;
        if (metadata.activationType === 'actionClicked') {
          console.log("Clicked");
        }
      })
    });
  } else if (slots.length > 3) {
    notifier.notify({ title: 'Correction slots spotted', message: 'Multiple correction slots spotted' });
  }
}

async function main() {
  const tok = await login();
  const projects = (await get_projects(tok)).filter(v => v.status === "waiting_for_correction");
  const project_id = (await inquirer.prompt({
    name: 'project',
    message: 'Chose the project you want to watch',
    type: 'list',
    choices: projects.map((v, i) => ({ name: v.project.name, value: v.project.id }))
  })).project;
  check_slots(tok, project_id);
  setInterval(check_slots.bind(null, tok, project_id), 300000);
}

main().catch(function(err) {
  process.nextTick(function() {
    if (err.response)
      console.log(err.response.body);
    throw err
  });
});

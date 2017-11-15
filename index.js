const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const Promise = require("bluebird");
const request = require('util').promisify(require("phin"));
const qs = require('querystring');
const url = require('url');
const http = require('http');
const opn = require('opn');
const inquirer = require('inquirer');
const notifier = require('node-notifier');
const moment = require('moment');
const fuzzy = require('fuzzy');
inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));

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
    return request({ method: "POST", url: "https://api.intra.42.fr/oauth/token",
      data: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: "http://127.0.0.1:9858/redirect_url",
        state: "meh"
      },
      headers: { "Content-Type": "application/json" }
    })
  }).then(function(res) {
    res.body = JSON.parse(res.body);
    console.log(res.body);
    return {
      request: function request_wrapper(opts, http) {
        if (typeof opts === "string") {
          opts = { url: opts }
        }
        if (!opts.headers) { opts.headers = {} }
        opts.headers['Authorization'] = 'Bearer ' + res.body.access_token;
        if (opts.data) opts.headers['Content-Type'] = 'application/json';
        opts.url = "https://api.intra.42.fr/v2/" + opts.url;
        return request(opts, http).then(res => {
          res.body = JSON.parse(res.body.toString());
          return res;
        });
      },
	  expires_in: res.body.expires_in
    }
  });
}

async function get_projects(tok) {
  let res = await request
    .get("https://api.intra.42.fr/v2/projects")
    .set({ Authorization: 'Bearer ' + tok });
  return res.body;
}

async function get_project(tok, project_id) {
  let res = await request
    .get("https://api.intra.42.fr/v2/projects/" + project_id)
    .set({ 'Authorization': 'Bearer ' + tok });
  return res.body;
}

async function get_project_users(tok, project_id) {
  let res = await request
    .get("https://api.intra.42.fr/v2/projects/" + project_id + "/projects_users?sort=-updated_at&page[size]=10&filter[campus]=1")
    .set({ 'Authorization': 'Bearer ' + tok });
  return res.body;
}

async function get_slots(request, project_id) {
  res = await request
    .get("https://api.intra.42.fr/v2/projects/" + project_id + "/slots")
  return res.body;
}

async function check_slots(request, project_id, project_name) {
  console.log("Checking corrections");
  const slots = await get_slots(request, project_id);
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
          opn("https://projects.intra.42.fr/projects/" + project_name + "/slots");
        }
      })
    });
  } else if (slots.length > 3) {
    notifier.notify({ title: 'Correction slots spotted', message: 'Multiple correction slots spotted' });
  }
}

function refreshTokens(refreshToken) {
  return request.post("https://api.intra.42.fr/oauth/token")
    .send({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
}

async function cmd_find_slot() {
  let { request, expires_in } = await login();
  const projects = tap(await request("/me")).body.projects_users.filter(v => v.status === "waiting_for_correction");
  const project = (await inquirer.prompt({
    name: 'project',
    message: 'Chose the project you want to watch',
    type: 'list',
    pageSize: process.stdout.rows - 3,
    choices: projects.map((v, i) => ({ name: v.project.name, value: v.project })),
  })).project;
  check_slots(request, project.id, project.name);
  let interval = setInterval(check_slots.bind(null, request, project.id, project.name), 60 * 1000);
  async function refreshTokensLogic() {
    console.log("Refreshing access token");
    clearInterval(interval);
    ({ access_token, refresh_token, expires_in} = await refreshTokens(refresh_token));
    interval = setInterval(check_slots.bind(null, request, project.id, project.name), 60 * 1000);
    setTimeout(refreshTokensLogic, expires_in * 1000);
  }
  setTimeout(refreshTokensLogic, expires_in * 1000);
}

async function main2() {
  let { access_token, refresh_token, expires_in } = await login();
  res = await request
    .get("https://api.intra.42.fr/v2/projects/" + 696 + "/scale_teams")
    .set({ 'Authorization': 'Bearer ' + access_token });
  console.log(JSON.stringify(res.body.map(v => [v.correcteds, v.final_mark]), null, 4));
}

function tap(v) {
  console.log(v);
  return v;
}

async function cmd_find_project_users() {
  let { request } = await login();
  const projects = (await request("/projects?page=5")).body.map((v, i) => ({ name: v.name, value: v }));
  const project = (await inquirer.prompt({
    name: 'project',
    message: 'Chose the project you want to watch',
    type: 'autocomplete',
    pageSize: process.stdout.rows - 3,
    source: async function(_, input) {
      input = input || '';
      return fuzzy.filter(input, projects, { extract: v => v.name }).map(v => v.original);
    }
  })).project;
  let i = 0;
  while (true) {
    for (u of (await request(`projects/${project.id}/projects_users?sort=-updated_at&page[size]=50&page[number]=${i}&filter[campus]=1`)).body.filter(v => v["validated?"])) {
      const lvl = (await request(`users/${u.user.id}`)).body.cursus_users.find(v => v.cursus_id == 1).level;
      const last_connection = (await request(`users/${u.user.id}/locations`)).body[0].begin_at;
      console.log(`${u.user.login} finished the project ${moment(u.teams[0].updated_at).fromNow()}, lvl = ${lvl}, last seen ${moment(last_connection).fromNow()}`);
    }
    i++;
  }
}

async function cmd_find_culprit() {
  let { request } = await login();
  for (let i = -1; i <= 1; i++) {
    for (let j = -2; j <= 2; j++) {
      let url = `/campus/1/locations?filter[host]=e6r${i + 4}p${j + 3}.vp&page[size]=5`
      const campuses = (await request(`/campus/1/locations?filter[host]=e6r${i + 4}p${j + 3}.vp&page[size]=5`)).body.map(v => ({ begin_at: v.begin_at, end_at: v.end_at, host: v.host, user: v.user.login }));
      console.log(campuses);
    }
  }
}

cmd_find_culprit().catch(function(err) {
  process.nextTick(function() {
    if (err.response)
      console.log(err.response.body);
    throw err
  });
});

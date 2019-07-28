# ftp-proxy

[ftp-srv](https://www.npmjs.com/package/ftp-srv) and [ftp](https://www.npmjs.com/package/ftp) in one package.

## Starting the server

Manually:
```bash
apt-get install docker-ce git node-10.0.0 # docker is not ultimately a requirement
git clone this_repo && cd this_repo
service docker start
npm install
export LISTENING_URL="ftp://0.0.0.0:21"
export PASSIVE_IP="$(curl -4 ifconfig.co)"
export PASSIVE_PORT_FROM=1024 PASSIVE_PORT_TO=65535
export HOST_mymachine.local=10.0.0.2 # set a virtualhost manually
USE_DOCKER_VHOST=1 USE_USER_HOST=1 node index.js
```

Using docker:
```bash
apt-get install docker-ce
git clone this_repo
docker build this_repo -t lezsakdomi/ftp-proxy
docker run -p 21:21 -e PASSIVE_IP="$(curl ifconfig.co)" -e USE_DOCKER_VHOST=1 -e ... lezsakdomi/ftp-proxy
```

## Usage instructions

### Docker

For docker auto-vhost-magic you should set an environment variable with key
`VIRTUAL_HOST` and value with wanted virtual domain for that host. Export port 21,
but don't bind. For example:
```bash
docker run -d --name host1 -e VIRTUAL_HOST=mydomain.example.com -p 21 -p 80:80 lamp
```

### FTP

The most important paragraph in this doc. Just append `@<host>[:port]` to the username
before login to select a virtual host. For example: `myuser@gmail.com@192.168.0.13:2121` or just `lezsakdomi@192.168.1.173` if the service is running on port 21.

## TODO

- Use [RFC 7151](https://tools.ietf.org/html/rfc7151), the FTP HOST command  
  Blocked by [ftp-srv#114](https://github.com/trs/ftp-srv/issues/114).
- Reduce communication overhead on downstream connection  
  Unfortunately ftp-srv has a silly interface where one should supply the whole
  stat for every information for every file.  
  Blocked by [ftp-srv#75](https://github.com/trs/ftp-srv/issues/75)
  - The `FTPFS.list()` could be optimized without that feature.
- Return proper response for empty and unaccessible directories  
  Again, the downstream communication needs optimization.
  - Find a way to reliably determine for a path if it's a directory or not
  - More promises
- Maybe use different libraries or none at all?

Pull requests are welcome :)

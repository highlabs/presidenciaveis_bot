#!/usr/bin/env node

const ipv6          = require('ipv6')
const asynclib      = require('async')
const Twit          = require('twit')
const Mastodon      = require('mastodon')
const minimist      = require('minimist')
const Mustache      = require('mustache')
const phantom       = require('phantom')
const fs            = require('fs')
const {WikiChanges} = require('wikichanges')

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false,
    config: './config.json'
  }
})

function address(ip) {
  if (Array.from(ip).includes(':')) {
    return new ipv6.v6.Address(ip)
  } else {
    i = new ipv6.v4.Address(ip)
    const subnetMask = 96 + i.subnetMask
    ip = `::ffff:${i.toV6Group()}/${subnetMask}`
    return new ipv6.v6.Address(ip)
  }
}

function ipToInt(ip) {
  return address(ip).bigInteger()
}

function compareIps(ip1, ip2) {
  const r = ipToInt(ip1).compareTo(ipToInt(ip2))
  if (r === 0) {
    return 0
  } else if (r > 0) {
    return 1
  } else {
    return -1
  }
}

function isIpInRange(ip, block) {
  if (Array.isArray(block)) {
    return (compareIps(ip, block[0]) >= 0) && (compareIps(ip, block[1]) <= 0)
  } else {
    const a = address(ip)
    const b = address(block)
    return a.isInSubnet(b)
  }
}

function isIpInAnyRange(ip, blocks) {
  for (let block of Array.from(blocks)) {
    if (isIpInRange(ip, block)) {
      return true
    }
  }
  return false
};

function getConfig(path) {
  const config = loadJson(path)
  // see if ranges are externally referenced as a separate .json files
  if (config.accounts) {
    for (let account of Array.from(config.accounts)) {
      if (typeof account.ranges === 'string') {
        account.ranges = loadJson(account.ranges)
      }
    }
  }
  console.log("loaded config from", path)
  return config
};

function loadJson(path) {
  if ((path[0] !== '/') && (path.slice(0, 2) !== './')) {
    path = `./${path}`
  }
  return require(path)
};

function getStatusLength(edit, name, template) {
  // https://support.twitter.com/articles/78124-posting-links-in-a-tweet
  const fakeUrl = 'http://t.co/BzHLWr31Ce'
  const status = Mustache.render(template, {name, url: fakeUrl, page: edit.page})
  return status.length
}

function getStatus(edit, name, template) {
  let page = edit.page
  const len = getStatusLength(edit, name, template);
  if (len > 140) {
    const newLength = edit.page.length - (len - 139)
    page = edit.page.slice(0, +newLength + 1 || undefined)
  }
  return Mustache.render(template, {
    name,
    url: edit.url,
    page
  })
};

const lastChange = {}

function isRepeat(edit) {
  const k = `${edit.wikipedia}`
  const v = `${edit.page}:${edit.user}`
  const r = lastChange[k] === v
  lastChange[k] = v
  return r
}

async function takeScreenshotOfDiff(url) {
  const phantomInstance = await phantom.create(['--ignore-ssl-errors=yes']);
  var filename = new Date().toString()+'.png';

  var page = await phantomInstance.createPage();
  await page.property('viewportSize', {width: 1024, height: 768});

  const status = await page.open(url);
  if (status === 'fail') {
      console.log('Failed to open page', url, 'for screen capture.')
      await phantomInstance.exit();
      return
  }

  const clipRect = await page.evaluate(function() {
    try {
        var diffBoundingRect = document.querySelector('table.diff.diff-contentalign-left').getBoundingClientRect();
        return {
            top: diffBoundingRect.top,
            left: diffBoundingRect.left,
            width: diffBoundingRect.width + 75, // for some reason phantomjs doesn't seem to get the sizing right
            height: diffBoundingRect.height,
        };
    } catch(e) {
      console.log('Error: no diff found on wikipedia page')
    }
  })
  await page.property('clipRect', clipRect)

  await page.render(filename);
  await phantomInstance.exit();

  return filename;
}


async function tweet(account, status, edit) {
  console.log(status)
  if (!argv.noop && (!account.throttle || !isRepeat(edit))) {


    if (account.mastodon) {
      const mastodon = new Mastodon(account.mastodon)

      const mastodonScreenshotFilename = await takeScreenshotOfDiff(edit.url);
      if (!mastodonScreenshotFilename) return;

      // upload the screenshot to mastodon
      mastodon.post('media', { file: fs.createReadStream(filename) }).then(function(response) {
        fs.unlink(filename)
        if (!response.data.id) {
          console.log('error uploading screenshot to mastodon')
          return
        }
        // post the status
        mastodon.post('statuses', { 'status': status, media_ids: [response.data.id] }, function(err) {
          if (err) {
            console.log(err);
          }
        })
      })
    }
    if (account.access_token) {
      const twitter = new Twit(account);

      const twitterScreenshotFilename = await takeScreenshotOfDiff(edit.url);
      if (!twitterScreenshotFilename) return;
      const b64content = fs.readFileSync(twitterScreenshotFilename, { encoding: 'base64' })

      // upload the screenshot to twitter
      twitter.post('media/upload', { media_data: b64content }, function (err, data, response) {
        // remove the screenshot file from the filesystem since it's no longer needed
        fs.unlink(twitterScreenshotFilename)

        if (err) {
          console.log(err);
          return
        }

        // add alt text for the media, for use by screen readers 
        const mediaIdStr = data.media_id_string
        const altText = "Screenshot of edit to "+edit.page
        const meta_params = { media_id: mediaIdStr, alt_text: { text: altText } }

        twitter.post('media/metadata/create', meta_params, function (err, data, response) {
          if (err) {
            console.log('metadata upload for twitter screenshot alt text failed with error', err)
          }
          // now we can reference the media and post a tweet (media will attach to the tweet)
          const params = {
            'status': status,
            'media_ids': [mediaIdStr]
          }

          twitter.post('statuses/update', params, function(err) {
            if (err) {
              console.log(err)
            }
          })

        })
      })

    }
  }
}

async function inspect(account, edit) {
  if (edit.url) {
    if (argv.verbose) {
      console.log(edit.url)
    }
    if (account.whitelist && account.whitelist[edit.wikipedia]
        && account.whitelist[edit.wikipedia][edit.page]) {
      status = getStatus(edit, edit.user, account.template);
      tweet(account, status, edit);
    } else if (account.ranges && edit.anonymous) {
      for (let name in account.ranges) {
        const ranges = account.ranges[name];
        if (isIpInAnyRange(edit.user, ranges)) {
          status = getStatus(edit, name, account.template)
          tweet(account, status, edit)
        }
      }
    }
  }
}

function checkConfig(config, error) {
  if (config.accounts) {
    return asynclib.each(config.accounts, canTweet, error)
  } else {
    return error("missing accounts stanza in config")
  }
}

function canTweet(account, error) {
  if (!account.access_token) {
    error(null)
  } else {
    try {
      const twitter = new Twit(account)
      const a = account['access_token']
      return twitter.get('search/tweets', {q: 'cats'}, function(err, data, response) {
        if (err) {
          error(err + " for access_token " + a)
        } else if (!response.headers['x-access-level'] ||
            (response.headers['x-access-level'].substring(0,10) !== 'read-write')) {
          error(`no read-write permission for access token ${a}`)
        } else {
          error(null)
        }
      });
    } catch (err) {
      error(`unable to create twitter client for account: ${account}`)
    }
  }
}

function main() {
  const config = getConfig(argv.config)
  return checkConfig(config, function(err) {
    if (!err) {
      const wikipedia = new WikiChanges({ircNickname: config.nick})
      return wikipedia.listen(edit =>
        Array.from(config.accounts).map((account) =>
          inspect(account, edit))
      );
    } else {
      return console.log(err)
    }
  })
}

if (require.main === module) {
  main()
}

module.exports = {
  main,
  address,
  ipToInt,
  compareIps,
  isIpInRange,
  isIpInAnyRange,
  getConfig,
  getStatus
}


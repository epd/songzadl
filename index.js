'use strict';

var fs = require('fs');
var async = require('async');
var request = require('request');
var path = require('path');
var exec = require('child_process').exec;

var jar = request.jar();
var r = request.defaults({
  jar: jar,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2145.2 Safari/537.36'
  }
});

function createDir(folder, done) {
  fs.mkdir(path.resolve(__dirname, folder), function (err) {

    // If an error occurs, we throw like normal except in the case where the
    // directory already exists. In that case, we don't care and just continue.
    if (err) {
      if (err.code === 'EEXIST') {
        return done();
      }
      return done(err);
    }

    done();
  });
}

function Song(data) {
  if (!this instanceof Song) { return new Song(data); }

  this.id = data.id;
  this.title = data.title;
  this.album = data.album;
  this.artist = data.artist.name;
  this.genre = data.genre;
  this.cover = data.cover_url;
}

Song.prototype.toString = function () {
  return this.title + ' by ' + this.artist;
};

Song.prototype._download = function (url, playlist, done) {
  var file = fs.createWriteStream(path.resolve(
    '/tmp/' + Date.now().toString(36)
  ));

  // Make a request to the CDN for our file.
  r.get(url)

  // If an error occurs, let's just log it, but don't halt execution.
  .on('error', function (err) {
    console.error('An error occurred while downloading:', url, '(' + err.toString() + ')');
    done();
  })

  // Listen for a good response code.
  .on('response', function (resp) {
    if (resp.statusCode !== 200) {
      return this.emit('error', new Error('Got response code ' + resp.statusCode + ' from CDN.'));
    }
  })

  // Otherwise, pipe our song to our output stream and when it's done,
  // trigger our callback.
  .on('end', function () {
    this._verifyTags(file.path, playlist);
    done();
  }.bind(this))

  // Once all of our events are accounted for, actually get the stream!
  .pipe(file);
};

Song.prototype._verifyTags = function (source, playlist) {

  // Override the artist, album, and title due to encoding issues.
  var filename = path.resolve(
    __dirname,
    'songs',
    playlist,
    this.artist + ' - ' + this.title + '.m4a'
  );
  exec('ffmpeg -y -i "' + source + '" -metadata artist="' + this.artist.replace(/"/g, '\\"') + '" -metadata title="' + this.title.replace(/"/g, '\\"') + '" -metadata album="' + this.album.replace(/"/g, '\\"') + '" "' + filename.replace(/"/g, '\\"') + '"', function (err, stdout, stderr) {
    if (err !== null) {
      throw new Error('An error occurred writing tags for file (' + source + '): ' + err.toString());
    }

    fs.unlinkSync(source);
  });
};

function Playlist(id) {
  if (!this instanceof Playlist) { return new Playlist(id); }

  this.id = id;
  this.url = 'http://songza.com/api/1/station/' + this.id;
  this.songs = [];
}

Playlist.prototype.getDetails = function () {
  r({ url: this.url, json: true }, function (err, resp, body) {
    if (err || resp.statusCode !== 200) {
      throw err || new Error(resp.responseText);
    }

    // Update some of our Playlist properties
    this.description = body.description;
    this.name = body.name;
    this.cover = body.cover_url + '?size=480&style=quad-flush';

    // Make sure our file structure is ready for downloads.
    this._createFileStructure();

  }.bind(this));
};

Playlist.prototype.getSongs = function () {
  var self = this, counter = 0, statusCode;

  async.doWhilst(

    // Perform this function until the condition below is violated.
    function (done) {
      setTimeout(function () {
        r({ url: self.url + '/next', json: true }, function (err, resp, body) {
          statusCode = resp.statusCode || 500;

          // If an error occurred, exit early.
          if (err) { return done(err); }

          // Otherwise, let's check if we've reached the end of the playlist or
          // if this is truly an error from the API.
          if (resp.statusCode !== 200) {
            if (body.message && body.message.match(/end of this playlist/)) {
              return done();
            }

            return done(new Error(body.message || body || 'An unexpected error occurred with the Songza API. Please try again.'));
          }

          // If all is well, we have the Song!
          var song = new Song(body.song);
          self.songs.push(song);
          console.log(counter > 0 ? '\n' : '', (++counter) + '.', song.toString());

          // Attempt to download it as well.
          song._download(body.listen_url, self.name, done);
        });
      }, 500);
    },

    // Execute the previous function until our statusCode is not 200 OK.
    function () { return statusCode === 200; },

    // When we are all done or an error occurs, break with this callback.
    function (err) {
      if (err) { throw err; }
      console.log('Retrieved', counter, 'songs from API.');
    }

  );
};

Playlist.prototype._createFileStructure = function () {
  async.eachSeries(

    // Scaffold our Playlist's directory where we will store our files.
    ['songs', 'songs/' + this.name],

    // Actually create our directories in series and watch for errors.
    function (path, done) {
      createDir(path, done);
    },
    function (err) {
      if (err) { throw err; }
    }
  );
};

/**
 * Grab our initial Playlist.
 */
var playlist = new Playlist(process.env.PLAYLIST_ID);
playlist.getDetails();
playlist.getSongs();

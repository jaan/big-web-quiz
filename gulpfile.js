/**
*
* Copyright 2016 Google Inc. All rights reserved.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
const path = require('path');
const gulp = require('gulp');
const gulpProcess = require('gulp-process');
const gutil = require('gulp-util');
const babel = require('gulp-babel');
const sourcemaps = require('gulp-sourcemaps');
const handlebars = require('gulp-handlebars');
const rename = require('gulp-rename');
const debug = require('gulp-debug');
const gzip = require('gulp-gzip');
const defineModule = require('gulp-define-module');
const sass = require('gulp-sass');
const respawn = require('respawn');
const del = require('del');
const source = require('vinyl-source-stream');
const buffer = require('vinyl-buffer');
const rollup = require('rollup-stream');
const rollupBabel = require('rollup-plugin-babel');
const nodeResolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs');

const paths = {
  serverScripts: {
    src: 'server/**/*.js',
    dest: 'build/'
  },
  serverTemplates: {
    src: 'server/templates/**/*.hbs',
    dest: 'build/templates'
  },
  sharedScripts: {
    src: 'shared/**/*.js',
    dest: 'build/shared'
  },
  scss: {
    src: 'client/css/**/*.scss',
    dest: 'build/static/css'
  }
};

const serverProcess = respawn(['node', `${paths.serverScripts.dest}/index.js`]);
const databaseProcess = respawn(['docker', 'start', '-a', 'bwq-mongo']);

// hook up the logging
for (const process of [serverProcess, databaseProcess]) {
  process.on('stdout', data => gutil.log(data.toString('utf-8')));
  process.on('stderr', data => gutil.log(data.toString('utf-8')));
  process.on('warn', data => gutil.log(data.toString('utf-8')));
}

// shut down gracefully
process.on('SIGINT', () => {
  serverProcess.stop(() => {
    databaseProcess.stop(() => {
      process.exit();
    });
  });
});

process.on('uncaughtException', () => {
  serverProcess.stop();
  databaseProcess.stop();
});

// TASKS:

function waitTask(ms) {
  return () => new Promise(r => setTimeout(r, ms));
}

function clean() {
  return del(['build']);
}

function serverScripts() {
  return gulp.src(paths.serverScripts.src, {
    since: gulp.lastRun(serverScripts)
  }).pipe(sourcemaps.init())
    .pipe(babel({
      presets: ['stage-3'],
      plugins: ["transform-es2015-modules-commonjs", ["transform-react-jsx", { "pragma":"h" }]]
    }))
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest(paths.serverScripts.dest));
}

function sharedScripts() {
  return gulp.src(paths.sharedScripts.src, {
    since: gulp.lastRun(sharedScripts)
  }).pipe(sourcemaps.init())
    .pipe(babel({
      presets: ['stage-3'],
      plugins: ["transform-es2015-modules-commonjs", ["transform-react-jsx", { "pragma":"h" }]]
    }))
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest(paths.sharedScripts.dest));
}

function serverTemplates() {
  return gulp.src(paths.serverTemplates.src, {
    since: gulp.lastRun(serverTemplates)
  }).pipe(handlebars())
    .pipe(defineModule('node'))
    .pipe(gulp.dest(paths.serverTemplates.dest)); 
}

function server() {
  serverProcess.start();
}

function databaseServer() {
  databaseProcess.start();
}

function serverRestart(cb) {
  serverProcess.stop(() => {
    serverProcess.start();
    cb();
  });
}

function scss() {
  return gulp.src(paths.scss.src, {
    since: gulp.lastRun(scss)
  }).pipe(sourcemaps.init())
    .pipe(sass({outputStyle: 'compressed'}).on('error', sass.logError))
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest(paths.scss.dest))
    .pipe(gzip({skipGrowingFiles: true}))
    .pipe(gulp.dest(paths.scss.dest));
}

function createScriptTask(src, dest) {
  const parsedPath = path.parse(src);
  let cache;
  return function script() {
    return rollup({
      entry: src,
      sourceMap: true,
      cache,
      format: 'iife',
      plugins: [
        nodeResolve({
          preferBuiltins: false,
          browser: true,
          jsnext: true,
          main: true
        }),
        commonjs({
          ignoreGlobal: true
        }),
        rollupBabel({
          presets: ['stage-3', ['es2015', {modules: false}]],
          plugins: [["transform-react-jsx", {pragma:"h"}], "external-helpers"]
        })
      ]
    }).on('bundle', function(bundle) {
      cache = bundle;
    }).pipe(source('index.js', parsedPath.dir))
      .pipe(buffer())
      .pipe(sourcemaps.init({loadMaps: true}))
      .pipe(rename({basename: /\/([^\/]+)$/.exec(parsedPath.dir)[1]}))
      .pipe(sourcemaps.write('.'))
      .pipe(gulp.dest(dest))
      .pipe(gzip({skipGrowingFiles: true}))
      .pipe(gulp.dest(dest));
  }
}

const browserScripts = [
  {src: './client/js/main/index.js', dest: './build/static/js'},
  {src: './client/js/admin/index.js', dest: './build/static/js'},
  {src: './client/js/presentation/index.js', dest: './build/static/js'}
];

for (const item of browserScripts) {
  item.task = createScriptTask(item.src, item.dest);
}

function watch() {
  const browserScriptTasks = browserScripts.map(i => i.task);

  // server
  gulp.watch(paths.serverScripts.src, gulp.series(serverScripts, serverRestart));
  gulp.watch(paths.serverTemplates.src, gulp.series(serverTemplates, serverRestart));
  gulp.watch(paths.sharedScripts.src, gulp.series(sharedScripts, gulp.parallel(...browserScriptTasks), serverRestart));

  // client
  gulp.watch(paths.scss.src, scss);

  for (const item of browserScripts) {
    gulp.watch(path.parse(item.src).dir + '/**/*.js', item.task);
  }
}

gulp.task('serverTemplates', serverTemplates);
gulp.task('browserScripts', gulp.parallel(...browserScripts.map(i => i.task)));

gulp.task('build', gulp.series(
  clean,
  gulp.parallel(serverScripts, serverTemplates, sharedScripts, scss, 'browserScripts')
));

gulp.task('serve', gulp.series(
  'build',
  gulp.parallel(
    databaseServer,
    // Wait for database to start up
    // TODO: I should find a better way to do this
    gulp.series(waitTask(1500), server),
    watch
  )
));
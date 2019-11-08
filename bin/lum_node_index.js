#!/usr/bin/env node
// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true*/

const check_compat = ()=>{
    delete require.cache[require.resolve('./check_compat.js')];
    if (!require('./check_compat.js').is_env_compat())
        process.exit();
};
check_compat();

const _ = require('lodash');
const etask = require('../util/etask.js');
const zerr = require('../util/zerr.js');
require('../lib/perr.js').run({});
const logger = require('../lib/logger.js');
const lpm_config = require('../util/lpm_config.js');
const lum_node = require('./lum_node.js');
const pm2 = require('pm2');
const child_process = require('child_process');
const path = require('path');
const semver = require('semver');
const sudo_prompt = require('sudo-prompt');
const pkg = require('../package.json');
const is_pkg = typeof process.pkg!=='undefined';
const util_lib = require('../lib/util.js');
const os = require('os');
const download = require('download');

class Lum_node_index {
    constructor(argv){
        this.argv = argv;
    }
    init_log(){
        process.env.LPM_LOG_FILE = 'luminati_proxy_manager.log';
        process.env.LPM_LOG_DIR = lpm_config.work_dir;
    }
    is_daemon_running(list){
        const daemon = list.find(p=>p.name==lpm_config.daemon_name);
        return !!daemon &&
            ['online', 'launching'].includes(daemon.pm2_env.status);
    }
    pm2_cmd(command, opt){ return etask(function*pm2_cmd(){
        this.on('uncaught', e=>{
            if (e.message=='process name not found')
                logger.notice('There is no running LPM daemon process');
            else
                logger.error('PM2: Uncaught exception: '+zerr.e2s(e));
        });
        this.on('finally', ()=>pm2.disconnect());
        yield etask.nfn_apply(pm2, '.connect', []);
        if (!Array.isArray(opt))
            opt = [opt];
        return yield etask.nfn_apply(pm2, '.'+command, opt);
    }); }
    start_daemon(){
        const _this = this;
        return etask(function*start_daemon(){
        this.on('uncaught', e=>{
            logger.error('PM2: Uncaught exception: '+zerr.e2s(e));
        });
        this.on('finally', ()=>pm2.disconnect());
        const daemon_start_opt = {
            name: lpm_config.daemon_name,
            script: _this.argv.$0,
            mergeLogs: false,
            output: '/dev/null',
            error: '/dev/null',
            autorestart: true,
            killTimeout: 5000,
            restartDelay: 5000,
            args: process.argv.filter(arg=>arg!='-d'&&!arg.includes('daemon')),
        };
        yield etask.nfn_apply(pm2, '.connect', []);
        yield etask.nfn_apply(pm2, '.start', [daemon_start_opt]);
        const bus = yield etask.nfn_apply(pm2, '.launchBus', []);
        bus.on('log:out', data=>{
            if (data.process.name != lpm_config.daemon_name)
                return;
            process.stdout.write(data.data);
            if (data.data.includes('Open admin browser'))
                this.continue();
        });
        yield this.wait();
        });
    }
    stop_daemon(){
        const _this = this;
        return etask(function*start_daemon(){
        this.on('uncaught', e=>{
            logger.error('PM2: Uncaught exception: '+zerr.e2s(e));
        });
        this.on('finally', ()=>pm2.disconnect());
        yield etask.nfn_apply(pm2, '.connect', []);
        const pm2_list = yield etask.nfn_apply(pm2, '.list', []);
        if (!_this.is_daemon_running(pm2_list))
            return logger.notice('There is no running LPM daemon process');
        const bus = yield etask.nfn_apply(pm2, '.launchBus', []);
        let start_logging;
        bus.on('log:out', data=>{
            if (data.process.name != lpm_config.daemon_name)
                return;
            start_logging = start_logging||data.data.includes('Shutdown');
            if (!start_logging || !data.data.includes('NOTICE'))
                return;
            process.stdout.write(data.data);
        });
        bus.on('process:event', data=>{
            if (data.process.name == lpm_config.daemon_name &&
                data.event=='stop')
            {
                this.continue();
            }
        });
        yield etask.nfn_apply(pm2, '.stop', [lpm_config.daemon_name]);
        yield this.wait();
        });
    }
    run_daemon(){
        let dopt = _.pick(this.argv.daemon_opt,
            ['start', 'stop', 'delete', 'restart', 'startup']);
        if (!Object.keys(dopt).length)
            return;
        if (dopt.start)
            this.start_daemon();
        else if (dopt.stop)
            this.stop_daemon();
        else if (dopt.delete)
            this.pm2_cmd('delete', lpm_config.daemon_name);
        else if (dopt.restart)
            this.pm2_cmd('restart', lpm_config.daemon_name);
        else if (dopt.startup)
        {
            let pm2_bin = path.resolve(__dirname, '../node_modules/.bin/pm2');
            try {
                child_process.execSync(pm2_bin+' startup');
                child_process.execSync(pm2_bin+' save');
            } catch(e){
                logger.warn('Failed to install startup script automatically, '
                    +`try run:\n${e.stdout.toString('utf-8')}\n${pm2_bin}`
                    +`save`);
            }
        }
        return true;
    }
    show_status(){
        const _this = this;
        return etask(function*status(){
        this.on('uncaught', e=>{
            logger.error('Status: Uncaught exception: '+zerr.e2s(e));
        });
        const pm2_list = yield _this.pm2_cmd('list');
        const running_daemon = _this.is_daemon_running(pm2_list);
        const tasks = yield lum_node.get_lpm_tasks({all_processes: true});
        if (!tasks.length && !running_daemon)
            return logger.notice('There is no LPM process running');
        let msg = 'Proxy manager status:\n';
        if (running_daemon)
        {
            msg += 'Running in daemon mode. You can close it by '+
            'running \'luminati --stop-daemon\'\n';
        }
        const fmt_num = n=>
            (+n).toLocaleString('en-GB', {maximumFractionDigits: 2});
        const get_task_str = (prefix, t)=>`${prefix} = `+
        `CPU: ${fmt_num(t.cpu)}%, Memory: ${fmt_num(t.memory)}%`;
        const manager = tasks.find(t=>t.cmd.includes('lum_node.js'));
        const workers = tasks.filter(t=>t.cmd.includes('worker.js'));
        const pid = manager.pid;
        msg += `PID: ${pid}\n`;
        msg += `${get_task_str('Manager (lum_node.js)', manager)}`;
        workers.forEach((w, i)=>
            msg += `\n${get_task_str(`Worker ${i} (worker.js)`, w)}`);
        logger.notice(msg);
        });
    }
    restart_on_child_exit(){
        if (!this.child)
            return;
        this.child.removeListener('exit', this.restart_on_child_exit);
        setTimeout(()=>this.create_child(), 5000);
    }
    shutdown_on_child_exit(){
        process.exit();
    }
    create_child(){
        process.env.LUM_MAIN_CHILD = true;
        this.child = child_process.fork(
            path.resolve(__dirname, 'lum_node.js'),
            process.argv.slice(2), {stdio: 'inherit', env: process.env});
        this.child.on('message', this.msg_handler.bind(this));
        this.child.on('exit', this.shutdown_on_child_exit);
        this.child.send({command: 'run', argv: this.argv});
    }
    msg_handler(msg){
        switch (msg.command)
        {
        case 'shutdown_master': return process.exit();
        case 'restart':
            this.child.removeListener('exit', this.shutdown_on_child_exit);
            this.child.on('exit', this.restart_on_child_exit.bind(this));
            this.child.kill();
            break;
        case 'upgrade':
            this.upgrade(e=>this.child.send({command: 'upgrade_finished',
                error: e}));
            break;
        }
    }
    upgrade(cb){
        if (is_pkg)
            return this.upgrade_pkg(cb);
        const log_file = path.join(lpm_config.work_dir,
            'luminati_upgrade.log');
        const npm_cmd = 'npm install --unsafe-perm -g '
            +'@luminati-io/luminati-proxy';
        const cmd = lpm_config.is_win ? npm_cmd :
            `bash -c "${npm_cmd} > ${log_file} 2>&1"`;
        const opt = {name: 'Luminati Proxy Manager'};
        logger.notice('Upgrading proxy manager...');
        sudo_prompt.exec(cmd, opt, (e, stdout, stderr)=>{
            if (cb)
                cb(e);
            if (e)
            {
                const msg = e.message=='User did not grant permission.' ?
                    e.message : zerr.e2s(e);
                logger.error('Error during upgrade: '+msg);
                if (!lpm_config.is_win)
                    logger.error(`Look at ${log_file} for more details`);
                return;
            }
            if (stderr)
                logger.error('NPM stderr: '+stderr);
            check_compat();
        });
    }
    upgrade_pkg(cb){
    return etask(function*(){
        const r = yield util_lib.json({
            url: `${pkg.api_domain}/lpm_config.json`,
            qs: {md5: pkg.lpm.md5, ver: pkg.version},
        });
        const newer = r.body.ver && semver.lt(pkg.version, r.body.ver);
        if (!newer)
            return cb();
        logger.notice('Upgrading proxy manager...');
        const install_path = path.resolve(os.homedir(),
            'luminati_proxy_manager');
        const download_url = `http://${pkg.api_domain}/static/lpm/`
            +`luminati-proxy-${r.body.ver}-beta.exe`;
        const upgrade_path = path.resolve(install_path, 'upgrade.exe');
        yield download(download_url, upgrade_path);
        child_process.spawn(upgrade_path, ['--upgrade_win', 1, '--kill_pid',
            process.pid], {detached: true});
        cb();
    }); }
    run(){
        if (this.run_daemon())
            return;
        if (this.argv.status)
            return this.show_status();
        this.init_log();
        if (lpm_config.is_win)
        {
            const readline = require('readline');
            readline.createInterface({input: process.stdin, output:
                process.stdout}).on('SIGINT', ()=>process.emit('SIGINT'));
        }
        // XXX krzysztof: duplication of handling siganls: why?
        ['SIGTERM', 'SIGINT', 'uncaughtException'].forEach(sig=>{
            process.on(sig, e=>{
                if (this.child)
                {
                    const error = zerr.e2s(e);
                    this.child.send({
                        command: 'shutdown',
                        reason: sig+(e ? ', master: error = '+error : ''),
                        error,
                    });
                }
                setTimeout(()=>process.exit(), 5000);
            });
        });
        if (!this.argv.upgrade)
            return this.create_child();
        const _this = this;
        return etask(function*_upgrade(){
            yield zerr.perr('upgrade_start');
            const pm2_list = yield _this.pm2_cmd('list');
            const running_daemon = _this.is_daemon_running(pm2_list);
            _this.upgrade(e=>etask(function*_cb_upgrade(){
                if (e)
                {
                    if (e.message != 'User did not grant permission.')
                        yield zerr.perr('upgrade_error', {error: e});
                    return;
                }
                logger.notice('Upgrade completed successfully');
                if (running_daemon)
                {
                    logger.notice('Restarting daemon...');
                    yield _this.pm2_cmd('restart', lpm_config.daemon_name);
                    logger.notice('Daemon restarted');
                }
                yield zerr.perr('upgrade_finish');
            }));
        });
    }
}
module.exports = Lum_node_index;

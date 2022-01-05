import { StandardDataSource } from './standard';
import { Config, getTemplate, DataSourceConfig, hasChinese, diffDses } from './utils';
import * as fs from 'fs-extra';
import * as path from 'path';
import { diff, Model } from './diff';
import { CodeGenerator, FilesManager } from './generators/generate';
import { info as debugInfo } from './debugLog';
import { FileStructures } from './generators/generate';
import { readRemoteDataSource } from './scripts';
import * as _ from 'lodash';
import { DsManager } from './DsManager';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0 as any;

export class Manager {
  readonly lockFilename = 'api-lock.json';

  allLocalDataSources: StandardDataSource[] = [];
  allConfigs: DataSourceConfig[];
  remoteDataSource: StandardDataSource;
  currConfig: DataSourceConfig;
  currLocalDataSource: StandardDataSource;

  fileManager: FilesManager;

  diffs = {
    modDiffs: [] as Model[],
    boDiffs: [] as Model[]
  };

  report = debugInfo;

  setReport(report: typeof debugInfo) {
    this.report = report;

    if (this.fileManager) {
      this.fileManager.report = report;
    }
  }

  mapModel<T extends {}>(model: T): Model {
    return Object.assign({}, model, { details: [] }) as any;
  }

  async selectDataSource(name: string) {
    this.currConfig = this.allConfigs.find((conf) => conf.name === name);

    await this.readLocalDataSource();
    await this.readRemoteDataSource();

    if (this.pollingId) {
      this.beginPolling(this.currConfig);
    }
  }
  // 全部一致
  makeAllSame() {
    if (this.allConfigs.length <= 1) {
      // Compatible with single origin without origin name
      this.allLocalDataSources[0] = this.remoteDataSource;
    } else {
      const remoteName = this.remoteDataSource.name;

      const remoteDsIndex = this.allLocalDataSources.findIndex((ds) => ds.name === remoteName);
      if (remoteDsIndex === -1) {
        this.allLocalDataSources.push(this.remoteDataSource);
      } else {
        this.allLocalDataSources[remoteDsIndex] = this.remoteDataSource;
      }
    }
    this.currLocalDataSource = this.remoteDataSource;
    this.setFilesManager();
  }
  // 使mod一致
  makeSameMod(modName: string) {
    const isRemoteModExists = this.remoteDataSource.mods.find((iMod) => iMod.name === modName);
    const isLocalModExists = this.currLocalDataSource.mods.find((iMod) => iMod.name === modName);

    if (!isRemoteModExists) {
      // 删除模块
      this.currLocalDataSource.mods = this.currLocalDataSource.mods.filter((mod) => mod.name !== modName);
      return;
    }

    const remoteMod = this.remoteDataSource.mods.find((iMod) => iMod.name === modName);

    if (isLocalModExists) {
      // 模块已存在。更新该模块
      const index = this.currLocalDataSource.mods.findIndex((iMod) => iMod.name === modName);

      this.currLocalDataSource.mods[index] = remoteMod;
    } else {
      // 模块已存在。创建该模块

      this.currLocalDataSource.mods.push(remoteMod);
      this.currLocalDataSource.reOrder();
    }
  }
  // 基础类一致
  makeSameBase(baseName: string) {
    const isRemoteExists = this.remoteDataSource.baseClasses.find((base) => base.name === baseName);
    const isLocalExists = this.currLocalDataSource.baseClasses.find((base) => base.name === baseName);

    if (!isRemoteExists) {
      // 删除基类
      this.currLocalDataSource.baseClasses = this.currLocalDataSource.baseClasses.filter(
        (base) => base.name !== baseName
      );
      return;
    }

    const remoteBase = this.remoteDataSource.baseClasses.find((base) => base.name === baseName);

    if (isLocalExists) {
      // 基类已存在, 更新该基类
      const index = this.currLocalDataSource.baseClasses.findIndex((base) => base.name === baseName);

      this.currLocalDataSource.baseClasses[index] = remoteBase;
    } else {
      // 基类不存在, 创建该基类
      this.currLocalDataSource.baseClasses.push(remoteBase);
      this.currLocalDataSource.reOrder();
    }
  }
  // 计算差异
  calDiffs() {
    try {
      const modDiffs = diff(
        this.currLocalDataSource.mods.map(this.mapModel),// 本地mod数据
        this.remoteDataSource.mods.map(this.mapModel)// 远程mod数据
      );
      const boDiffs = diff(
        this.currLocalDataSource.baseClasses.map(this.mapModel), // 远程基类数据
        this.remoteDataSource.baseClasses.map(this.mapModel), // 远程基类数据
        false
      );

      this.diffs = {
        modDiffs,
        boDiffs
      };
    } catch (error) {
      console.error(error);
    }
  }
  // 构造 初始化全部配置，当前项目配置
  constructor(private projectRoot: string, config: Config, configDir = process.cwd()) {
    this.allConfigs = config.getDataSourcesConfig(configDir);
    this.currConfig = this.allConfigs[0];
  }
  pollingId = null;
  // 轮询
  private polling(currConfig: DataSourceConfig) {
    this.pollingId = setTimeout(() => {
      this.readRemoteDataSource(currConfig);
      console.log('开启定时器');
      this.polling(currConfig);
    }, currConfig.pollingTime * 1000);
  }
  // 启东轮询
  beginPolling(currConfig = this.currConfig) {
    this.readRemoteDataSource(currConfig);
    if (this.pollingId) {
      console.log('清理定时器');
      clearTimeout(this.pollingId);
    }
    this.polling(currConfig);
  }
  // 停止轮询
  stopPolling() {
    if (this.pollingId) {
      console.log('清理定时器');
      clearTimeout(this.pollingId);
      this.pollingId = null;
    }
  }
  // 准备
  async ready() {
    // 存在本地资源
    if (this.existsLocal()) {
      // 读取本地资源
      await this.readLocalDataSource();
      // 读取远程资源
      await this.initRemoteDataSource();
    } else {
      const promises = this.allConfigs.map((config) => {
        return this.readRemoteDataSource(config);
      });
      this.allLocalDataSources = await Promise.all(promises);

      this.currLocalDataSource = this.allLocalDataSources[0];
      this.remoteDataSource = this.currLocalDataSource;

      await this.regenerateFiles();
    }
  }
  // 本地存在
  existsLocal() {
    return (
      fs.existsSync(path.join(this.currConfig.outDir, this.lockFilename)) ||
      fs.existsSync(path.join(this.currConfig.outDir, 'api.lock'))
    );
  }
  // 读取锁文件
  async readLockFile(): Promise<string> {
    let lockFile = path.join(this.currConfig.outDir, 'api-lock.json');
    const isExists = fs.existsSync(lockFile);
    // api-lock.json,存在就是用
    // 不存在api-lock.json时，使用api.lock
    if (!isExists) {
      lockFile = path.join(this.currConfig.outDir, 'api.lock');
    }

    try {
      const localDataStr = await fs.readFile(lockFile, {
        encoding: 'utf8'
      });
      return localDataStr;
    } catch (error) {
      return '';
    }
  }
  // 读取本地数据
  async readLocalDataSource() {
    try {
      this.report('读取本地数据中...');
      const localDataStr = await this.readLockFile();
      if (!localDataStr) {
        // 无数据，停止
        return;
      }

      this.report('读取本地完成');
      const localDataObjects = JSON.parse(localDataStr) as StandardDataSource[];

      this.allLocalDataSources = localDataObjects.map((ldo) => {
        // 从lock文件中获取数据源
        return StandardDataSource.constructorFromLock(ldo, ldo.name);
      });

      // Filter name changed origin
      this.allLocalDataSources = this.allLocalDataSources.filter((ldo) => {
        return Boolean(this.allConfigs.find((config) => config.name === ldo.name));
      });
      // 本地资源配置 《 所有配置长度
      if (this.allLocalDataSources.length < this.allConfigs.length) {
        this.allConfigs.forEach((config) => {
          if (!this.allLocalDataSources.find((ds) => ds.name === config.name)) {
            this.allLocalDataSources.push(
              new StandardDataSource({
                mods: [],
                name: config.name,
                baseClasses: []
              })
            );
          }
        });
      }
      // 当前本地资源
      this.currLocalDataSource = this.allLocalDataSources[0];
      // 配置名字存在，且所有配置数据源存在
      if (this.currConfig.name && this.allLocalDataSources.length > 1) {
        this.currLocalDataSource =
          this.allLocalDataSources.find((ds) => ds.name === this.currConfig.name) ||
          new StandardDataSource({
            mods: [],
            name: this.currConfig.name,
            baseClasses: []
          });
      }

      this.setFilesManager();
      this.report('本地对象创建成功');
    } catch (e) {
      throw new Error('读取 lock 文件错误！' + e.toString());
    }
  }

  checkDataSource(dataSource: StandardDataSource) {
    const { mods, baseClasses } = dataSource;

    const errorModNames = [] as string[];
    const errorBaseNames = [] as string[];

    mods.forEach((mod) => {
      if (hasChinese(mod.name)) {
        errorModNames.push(mod.name);
      }
    });

    baseClasses.forEach((base) => {
      if (hasChinese(base.name)) {
        errorBaseNames.push(base.name);
      }
    });

    if (errorBaseNames.length && errorModNames.length) {
      const errMsg = ['当前数据源有如下项不符合规范，需要后端修改'];
      errorModNames.forEach((modName) => errMsg.push(`模块名${modName}应该改为英文名！`));
      errorBaseNames.forEach((baseName) => errMsg.push(`基类名${baseName}应该改为英文名！`));

      throw new Error(errMsg.join('\n'));
    }
  }

  async initRemoteDataSource(config = this.currConfig) {
    const projName = this.projectRoot;
    const currProj = {
      originUrl: this.currConfig.originUrl,
      projectName: projName
    } as any;

    // 只查询当前数据源，用户只关心当前数据源。
    let oldRemoteSource = DsManager.getLatestDsInProject(currProj);
    // 如果本地有数据源
    if (oldRemoteSource) {
      this.remoteDataSource = StandardDataSource.constructorFromLock(oldRemoteSource, oldRemoteSource.name);
    } else {
      // 没有本地数据源的情况，读取远程数据源
      const remoteDataSource = await readRemoteDataSource(config, this.report);
      this.remoteDataSource = remoteDataSource;
      // 将远程数据缓存到本地
      await DsManager.saveDataSource(currProj, this.remoteDataSource);
    }
  }

  async readRemoteDataSource(config = this.currConfig) {
    const projName = this.projectRoot;
    const currProj = {
      originUrl: this.currConfig.originUrl,
      projectName: projName
    } as any;

    // 只查询当前数据源，用户只关心当前数据源。
    let oldRemoteSource = DsManager.getLatestDsInProject(currProj);

    if (!oldRemoteSource) {
      if (this.remoteDataSource) {
        DsManager.saveDataSource(currProj, this.remoteDataSource);
        oldRemoteSource = this.remoteDataSource;
      } else {
        const remoteDataSource = await readRemoteDataSource(config, this.report);
        this.remoteDataSource = remoteDataSource;
        DsManager.saveDataSource(currProj, this.remoteDataSource);
        return remoteDataSource;
      }
    }
    /**
     * mods
     * baseClasses
     */
    const remoteDataSource = await readRemoteDataSource(config, this.report);
    this.remoteDataSource = remoteDataSource;

    const { modDiffs, boDiffs } = diffDses(oldRemoteSource, this.remoteDataSource);
    // originUrl:'http://localhost:8000/static/server4.json'
    // projectName:'/Users/haotian/haotian/github/vscode-plugins/pont-out-test'
    // 存在差异化，将数据存储
    // details中存储的变更信息
    if (modDiffs.length || boDiffs.length) {
      DsManager.saveDataSource(currProj, this.remoteDataSource);
    }

    return remoteDataSource;
  }

  async lock() {
    await this.fileManager.saveLock();
  }

  dispatch(files: {}) {
    return _.mapValues(files, (value: Function | {}) => {
      if (typeof value === 'function') {
        return value();
      }

      if (typeof value === 'object') {
        return this.dispatch(value);
      }

      return value;
    });
  }

  getGeneratedFiles() {
    this.setFilesManager();

    const files = this.fileManager.fileStructures.getFileStructures();

    try {
      return this.dispatch(files);
    } catch (err) {
      return {};
    }
  }

  async update(oldFiles: {}) {
    const files = this.getGeneratedFiles();

    try {
      await this.fileManager.regenerate(files, oldFiles);
    } catch (e) {
      console.log(e.stack);
      throw new Error(e);
    }
  }

  async regenerateFiles() {
    const files = this.getGeneratedFiles();
    await this.fileManager.regenerate(files);
  }
  // 设置文件管理器
  setFilesManager() {
    this.report('文件生成器创建中...');
    const { default: Generator, FileStructures: MyFileStructures } = getTemplate(
      this.currConfig.templatePath,
      this.currConfig.templateType
    );

    const generators = this.allLocalDataSources.map((dataSource) => {
      const config = this.getConfigByDataSourceName(dataSource.name);
      const generator: CodeGenerator = new Generator(this.currConfig.surrounding, config?.outDir);
      generator.setDataSource(dataSource);
      generator.usingMultipleOrigins = this.currConfig.usingMultipleOrigins;

      if (_.isFunction(generator.getDataSourceCallback)) {
        generator.getDataSourceCallback(dataSource);
      }
      return generator;
    });
    let FileStructuresClazz = FileStructures as any;

    if (MyFileStructures) {
      FileStructuresClazz = MyFileStructures;
    }

    this.fileManager = new FilesManager(
      new FileStructuresClazz(
        generators,
        this.currConfig.usingMultipleOrigins, // false
        this.currConfig.surrounding, // typeScript
        this.currConfig.outDir, // "/Users/haotian/haotian/github/vscode-plugins/pont-out-test/src/services2"
        this.currConfig.templateType // "hooks"
      ),
      this.currConfig.outDir
    );
    this.fileManager.prettierConfig = this.currConfig.prettierConfig;

    this.report('文件生成器创建成功！');
    this.fileManager.report = this.report;
  }

  /** 获取报表数据 */
  getReportData() {
    const currProj = {
      originUrl: this.currConfig.originUrl,
      projectName: this.projectRoot
    } as any;

    return DsManager.getReportData(currProj);
  }

  /** 获取当前dataSource对应的config */
  getConfigByDataSourceName(name: string) {
    if (name) {
      return this.allConfigs.find((config) => config.name === name) || this.currConfig;
    }

    // 没有name时，表示是单数据源
    return this.currConfig;
  }

  /** 打开接口变更报表 */
  openReport() {
    const currProj = {
      originUrl: this.currConfig.originUrl,
      projectName: this.projectRoot
    } as any;
    DsManager.openReport(currProj);
  }
}

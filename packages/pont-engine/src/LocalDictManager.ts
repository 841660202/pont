import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
// 本地目录管理
class LocalDictManager {
  static singleInstance = null as LocalDictManager;
  // 获取单例
  static getSingleInstance() {
    if (!LocalDictManager.singleInstance) {
      LocalDictManager.singleInstance = new LocalDictManager();
      return LocalDictManager.singleInstance;
    }

    return LocalDictManager.singleInstance;
  }
  // 本地目录
  private localDictDir = os.homedir() + '/.pont';

  constructor() {
    if (!fs.pathExistsSync(this.localDictDir)) {
      fs.mkdirpSync(this.localDictDir);
    }
  }
  // 文件存在？
  isFileExists(filename: string) {
    const filePath = path.join(this.localDictDir, filename);

    return fs.existsSync(filePath);
  }
  // 移除文件
  removeFile(filename: string) {
    const filePath = path.join(this.localDictDir, filename);

    if (fs.existsSync(filePath)) {
      return fs.remove(filePath);
    }
  }
  // 异步加载JSON数据
  loadJsonFileIfExistsSync(filename: string) {
    const fileContent = this.loadFileIfExistsSync(filename);

    try {
      if (fileContent) {
        return JSON.parse(fileContent);
      } else {
        return false;
      }
    } catch (error) {
      console.log(error);
      return false;
    }
  }
  // 加载文件内容
  loadFileIfExistsSync(filename: string) {
    const filePath = path.join(this.localDictDir, filename);

    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, {
        encoding: 'utf8'
      });

      return fileContent;
    }

    return false;
  }
  // 同步加载文件
  async loadFileIfExists(filename: string) {
    const filePath = path.join(this.localDictDir, filename);

    if (fs.existsSync(filePath)) {
      const fileContent = await fs.readFile(filePath, {
        encoding: 'utf8'
      });

      return fileContent;
    }

    return false;
  }
  // 同步保存文件
  async saveFile(filename: string, content: string) {
    const filePath = path.join(this.localDictDir, filename);
    const dirname = path.dirname(filePath);

    if (!fs.pathExistsSync(dirname)) {
      fs.mkdirpSync(dirname);
    }

    return fs.writeFileSync(filePath, content);
  }
  // 异步保存文件
  saveFileSync(filename: string, content: string) {
    const filePath = path.join(this.localDictDir, filename);
    const dirname = path.dirname(filePath);

    if (!fs.pathExistsSync(dirname)) {
      fs.mkdirpSync(dirname);
    }

    return fs.writeFileSync(filePath, content);
  }
  // 同步追加文件内容
  async appendFileSync(filename: string, content: string) {
    const filePath = path.join(this.localDictDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.appendFile(filePath, content);
    }
  }
  // 获取文件路径
  getFilePath(filename: string) {
    return path.join(this.localDictDir, filename);
  }
}
// 实例化暴露
const PontDictManager = LocalDictManager.getSingleInstance();
export { PontDictManager };

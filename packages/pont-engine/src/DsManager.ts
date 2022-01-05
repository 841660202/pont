/**
 * @author jasonHzq
 * @description 持久化接口变更记录。
 *
 * 设计思路
 *
 * 在 ~/.pont 下保存接口变更记录。每个项目（Project）占用一个目录。
 * 保存一份总的 manifest 的 JSON 文件。该文件包括所有项目的信息，始终和接口变更目录保持一致。方便做信息查询。
 *
 * 项目（Project）以用户的项目加 originUrl 两个字段来唯一确定。
 *
 * 生成报表使用 diffs 方法来分析变更信息。
 * @todo 报表渲染待优化
 */
import { execSync } from 'child_process';
import { StandardDataSource } from './standard';
import { PontDictManager } from './LocalDictManager';
import { diffDses } from './utils';
import { diff } from './diff';
import * as dayjs from 'dayjs'
export class Record {
  saveTime = dayjs().format('YYYY-MM-DD HH:mm:ss'); // 存储时间
  constructor(public filename: string) {} // 文件名
}

class Project {
  constructor(
    public projectName: string,
    public originUrl: string,
    public records: Record[] = [],
    public projectPath: string
  ) {}
}

class ProjectsManifest {
  constructor(public projects: Project[]) {}
}

class LocalDsManager {
  private readonly PROJECTS_MANIFEST_FILE = 'projects_manifest.json';
  static singleInstance = null as LocalDsManager;
  // 获取实例
  static getSingleInstance() {
    if (!LocalDsManager.singleInstance) {
      LocalDsManager.singleInstance = new LocalDsManager();
    }

    return LocalDsManager.singleInstance;
  }

  /** 获取该项目最新的数据源 */
  getLatestDsInProject(project: Project): StandardDataSource {
    // 项目清单信息
    const manifest = this.getProjectsManifest();
    // 找到清单中的项目
    const foundProj = manifest.projects.find(
      (proj) => proj.originUrl === project.originUrl && proj.projectName === project.projectName
    );
    // 项目存在，且有记录
    if (foundProj && foundProj.records.length) {
      const record = foundProj.records[foundProj.records.length - 1];
      const recordPath = foundProj.projectPath + '/' + record.filename;
      // 将缓存的数据加载返回
      return PontDictManager.loadJsonFileIfExistsSync(recordPath);
    }
    // 没有缓存数据
    return null;
  }
  // 获取项目清单
  getProjectsManifest(): ProjectsManifest {
    // 获取清单内容
    const content = PontDictManager.loadJsonFileIfExistsSync(this.PROJECTS_MANIFEST_FILE);
    // 内容不存在，初始化空内容
    if (!content) {
      const manifest = new ProjectsManifest([]);
      PontDictManager.saveFileSync(this.PROJECTS_MANIFEST_FILE, JSON.stringify(manifest, null, 2));

      return manifest;
    }
    // 内容存在直接返回
    return content;
  }
  // 存在项目
  isProjectExists(project: Project) {
    // 清单中项目信息
    const projectsInfo = this.getProjectsManifest();
    // 清单中有就是true,没有是false
    return projectsInfo.projects.find((proj) => {
      return proj.originUrl === project.originUrl && proj.projectName === project.projectName;
    });
  }
  // 追加记录
  async appendRecord(project: Project, record: string): Promise<void> {
    // 文件名
    const filename = 'record_' + project.records.length;
    // 清单
    const manifest = this.getProjectsManifest();
    // 找到项目
    const proj = manifest.projects.find((proj) => proj.projectPath === project.projectPath);
    // 追加记录
    proj.records.push(new Record(filename));
    // 覆盖旧的清单文件
    await PontDictManager.saveFile(`${project.projectPath}/${filename}`, record);
    await this.saveManifest(manifest);
  }
  // 同步保存清单
  async saveManifest(manifest: ProjectsManifest) {
    return PontDictManager.saveFile(this.PROJECTS_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  }
  // 创建项目
  async createProject(project: Project) {
    const manifest = this.getProjectsManifest();
    const projectPath = 'project_' + manifest.projects.length;
    const proj = new Project(project.projectName, project.originUrl, [], projectPath);
    manifest.projects.push(proj);
    await this.saveManifest(manifest);

    return proj;
  }
  // 存储数据源
  async saveDataSource(project: Project, ds: StandardDataSource) {
    /**
     * {
          projectName: "/Users/haotian/haotian/github/vscode-plugins/pont-out-test",
          originUrl: "http://localhost:8000/static/server4.json",
          records: [
            {
              filename: "record_0",
              saveTime: "2022-01-03 22:27:45",
            },
            {
              filename: "record_1",
              saveTime: "2022-01-03 22:27:45",
            },
            {
              filename: "record_2",
              saveTime: "2022-01-03 22:28:41",
            },
          ],
          projectPath: "project_0",
        }
     */
    let proj = this.isProjectExists(project);
    if (!proj) {
      proj = await this.createProject(project);
    }
    // 追加变更信息记录
    await this.appendRecord(proj, JSON.stringify(ds, null, 2));
  }
  // 获取报告数据
  getReportData(project: Project) {
    const manifest = this.getProjectsManifest();
    const proj = manifest.projects.find(
      (p) => p.originUrl === project.originUrl && p.projectName === project.projectName
    );

    if (!proj) {
      throw new Error('该项目暂无记录！');
      return;
    }
    type Model = ReturnType<typeof diff>[0];
    const diffs = [] as Array<{
      saveTime: Date;
      boDiffs: Model[];
      modDiffs: Model[];
    }>;

    proj.records.forEach((record, recordIndex) => {
      if (recordIndex === 0) {
        return;
      }
      const lastRecord = proj.records[recordIndex - 1];
      const currRecord = record;
      const lastDs: StandardDataSource = PontDictManager.loadJsonFileIfExistsSync(
        `${project.projectPath}/${lastRecord.filename}`
      );
      const currDs: StandardDataSource = PontDictManager.loadJsonFileIfExistsSync(
        `${project.projectPath}/${currRecord.filename}`
      );

      const currDiff = diffDses(lastDs, currDs);
      diffs.push({
        saveTime: currRecord.saveTime,
        boDiffs: currDiff.boDiffs,
        modDiffs: currDiff.modDiffs
      });
    });

    return {
      records: project.records,
      diffs
    };
  }
  // 打开报告数据
  openReport(project: Project) {
    const { diffs, records } = this.getReportData(project);

    // 后续优化。
    PontDictManager.saveFile(
      'report.html',
      `
<html>
  <div>项目记录数：${records.length}</div>
  <div>历次变更详情：</div>
  报表UI 待优化：
  <pre>
  ${diffs.map((diff) => {
    return `
      <pre>
      ${diff.saveTime}：
      ${diff.modDiffs.join('\n')}
      ${diff.boDiffs.join('\n')}
      </pre>
    `;
  })}
  </pre>
</html>
    `
    );

    const htmlPath = PontDictManager.getFilePath('report.html');
    execSync(`open ${htmlPath}`);
  }
}
// 返回实例
const DsManager = LocalDsManager.getSingleInstance();
export { DsManager };

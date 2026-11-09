import { Alert, Collapse, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";

// 应用管理和主题管理共用的上传框：只选文件，不自动上传，点“安装”时再提交。
export function PackageDragger({
  file,
  onChange,
  disabled,
  text,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
  disabled: boolean;
  text: string;
}) {
  return (
    <Upload.Dragger
      accept=".zip"
      maxCount={1}
      disabled={disabled}
      beforeUpload={(f) => {
        onChange(f);
        return false;
      }}
      onRemove={() => onChange(null)}
      fileList={file ? [{ uid: "package", name: file.name, status: "done" }] : []}
    >
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text">{text}</p>
    </Upload.Dragger>
  );
}

// 应用管理用的多选上传框：一次选或拖进多个模块包，交给调用方排队安装。不显示自带的文件列表，排队列表由调用方显示。
export function PackagesDragger({ onAdd, text }: { onAdd: (files: File[]) => void; text: string }) {
  return (
    <Upload.Dragger
      accept=".zip"
      multiple
      showUploadList={false}
      // 多选时 beforeUpload 每个文件调用一次，fileList 是这次选中的全部文件；只在最后一个时交出去，一次加进队列。
      beforeUpload={(f, list) => {
        if (f === list[list.length - 1]) onAdd(list);
        return false;
      }}
    >
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text">{text}</p>
    </Upload.Dragger>
  );
}

export type OperationResult = { ok: boolean; message: string; log: string };

// ResultAlert 显示最近一次安装或卸载的结果，失败时默认展开日志。
export function ResultAlert({ result }: { result: OperationResult }) {
  return (
    <Alert
      type={result.ok ? "success" : "error"}
      showIcon
      message={result.message}
      description={result.log && <LogCollapse log={result.log} open={!result.ok} />}
    />
  );
}

// LogCollapse 是可以展开的“日志”，open 为 true 时默认展开（失败时）。
export function LogCollapse({ log, open }: { log: string; open: boolean }) {
  return (
    <Collapse
      ghost
      size="small"
      defaultActiveKey={open ? ["log"] : []}
      items={[{ key: "log", label: "日志", children: <pre className="log">{log}</pre> }]}
    />
  );
}

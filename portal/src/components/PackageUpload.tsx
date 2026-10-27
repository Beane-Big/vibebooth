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

export type OperationResult = { ok: boolean; message: string; log: string };

// ResultAlert 显示最近一次安装或卸载的结果，失败时默认展开日志。
export function ResultAlert({ result }: { result: OperationResult }) {
  return (
    <Alert
      type={result.ok ? "success" : "error"}
      showIcon
      message={result.message}
      description={
        result.log && (
          <Collapse
            ghost
            size="small"
            defaultActiveKey={result.ok ? [] : ["log"]}
            items={[{ key: "log", label: "日志", children: <pre className="log">{result.log}</pre> }]}
          />
        )
      }
    />
  );
}
